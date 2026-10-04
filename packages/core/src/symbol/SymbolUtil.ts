import picomatch from 'picomatch'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { bigintJsonNumberReplacer, type DeepReadonly, EventDispatcher } from '../common/index.js'
import type { AstNode } from '../node/index.js'
import type { RangeLike } from '../source/index.js'
import { Range } from '../source/index.js'
import type {
	AllCategory,
	Symbol,
	SymbolIsotope,
	SymbolLocationBuiltInContributor,
	SymbolLocationMetadata,
	SymbolMap,
	SymbolMetadata,
	SymbolTable,
	SymbolUsageType,
} from './Symbol.js'
import {
	SymbolIsotopeScope,
	SymbolLocation,
	SymbolPath,
	SymbolUsageTypes,
	SymbolVisibility,
} from './Symbol.js'

const contextualSymbols = new WeakMap<Symbol, Symbol>()
const isotopeMatchers = new WeakMap<SymbolIsotope, {
	patterns: string[]
	match: (uri: string) => boolean
}>()

export interface LookupResult {
	/**
	 * The {@link SymbolMap} that contains the symbol. If `symbol` is `undefined`, this property will be the map that could
	 * potentially store the symbol if it's ever created. `undefined` if no such map exists.
	 */
	parentMap:
		| SymbolMap
		| undefined
	/**
	 * The {@link Symbol} of which `symbol` is a member. If `symbol` is `undefined`, this property will be the symbol that could
	 * potentially store the symbol as a member if it's ever created. `undefined` if no such symbol exists.
	 */
	parentSymbol:
		| Symbol
		| undefined
	/**
	 * The {@link Symbol} corresponding to the `path`. `undefined` if no such symbol exists.
	 */
	symbol: Symbol | undefined
}

interface SymbolEvent {
	symbol: Symbol
}
interface SymbolLocationEvent extends SymbolEvent {
	type: SymbolUsageType
	location: SymbolLocation
}

type UriSymbolCache = Record<string, Set<string>>
interface DocAndNode {
	doc: TextDocument
	node: AstNode
}

export class SymbolUtil extends EventDispatcher<{
	symbolCreated: SymbolEvent
	symbolAmended: SymbolEvent
	symbolRemoved: SymbolEvent
	symbolLocationCreated: SymbolLocationEvent
	symbolLocationRemoved: SymbolLocationEvent
}> {
	readonly #global: SymbolTable

	readonly #trimmableSymbols = new Set<string>()
	readonly #cache: { [contributor: string]: UriSymbolCache } = Object.create(null)

	#currentContributor:
		| string
		| undefined

	/**
	 * @internal
	 */
	_delayedOps: ((this: void) => unknown)[] = []
	/**
	 * @internal
	 */
	_inDelayMode: boolean

	get global() {
		return this.#global
	}

	constructor(
		global: SymbolTable,
		/** @internal */
		_currentContributor?: string,
		/** @internal */
		_inDelayMode = false,
	) {
		super()
		this.#global = global
		this.#currentContributor = _currentContributor
		this._inDelayMode = _inDelayMode

		this.on('symbolCreated', ({ symbol }) => {
			this.#trimmableSymbols.add(SymbolPath.toString(symbol))
		}).on('symbolRemoved', ({ symbol }) => {
			this.#trimmableSymbols.delete(SymbolPath.toString(symbol))
		}).on('symbolLocationCreated', ({ symbol, location }) => {
			const cache =
				(this.#cache[location.contributor ?? 'undefined'] ??= Object.create(null) as never)
			const fileSymbols = (cache[location.uri] ??= new Set())
			const path = SymbolPath.toString(symbol)
			fileSymbols.add(path)
			this.#trimmableSymbols.delete(path)
		}).on('symbolLocationRemoved', ({ symbol }) => {
			const path = SymbolPath.toString(symbol)
			this.#trimmableSymbols.add(path)
		})
	}

	/**
	 * Build the internal cache of the SymbolUtil according to the current global symbol table.
	 */
	buildCache(): void {
		SymbolUtil.forEachSymbol(this.global, (symbol) => {
			this.emit('symbolCreated', { symbol })
			SymbolUtil.forEachLocationOfSymbol(symbol, ({ type, location }) => {
				this.emit('symbolLocationCreated', { symbol, type, location })
			})
		})
	}

	/**
	 * @returns A clone of this SymbolUtil that is in delay mode: changes to the symbol table happened in the clone will
	 * not take effect until the {@link SymbolUtil.applyDelayedEdits} method is called on that clone.
	 *
	 * The clone shares the same reference of the global symbol table and symbol stacks, meaning that after
	 * `applyDelayedEdits` is called, the original SymbolUtil will also be modified.
	 */
	clone(): SymbolUtil {
		return new SymbolUtil(
			this.#global,
			this.#currentContributor,
			true,
		)
	}

	/**
	 * Apply edits done during the delay mode.
	 */
	applyDelayedEdits(): void {
		this._delayedOps.forEach((f) => f())
		this._delayedOps = []
		this._inDelayMode = false
	}

	/**
	 * All symbol locations added in `fn` are associated with the specified `contributor`.
	 *
	 * @param contributor The name of the contributor which will add symbols to the symbol table. See {@link SymbolLocation.contributor}
	 * @param fn All symbols added in this function will be considered as URI bound.
	 * @param keepExisting Default to `false`, indicating existing symbols contributed by the specified contributor will be removed first. Set to `true` to keep them instead.
	 */
	contributeAs(contributor: SymbolLocationBuiltInContributor, fn: () => unknown): this
	contributeAs(contributor: string, fn: () => unknown): this
	contributeAs(contributor: string, fn: () => unknown): this {
		const originalValue = this.#currentContributor
		this.#currentContributor = contributor
		try {
			fn()
		} finally {
			this.#currentContributor = originalValue
		}
		return this
	}

	/**
	 * This is an asynchronous version of {@link contributeAs}.
	 */
	async contributeAsAsync(
		contributor: SymbolLocationBuiltInContributor,
		fn: () => PromiseLike<unknown>,
	): Promise<this>
	async contributeAsAsync(contributor: string, fn: () => PromiseLike<unknown>): Promise<this>
	async contributeAsAsync(contributor: string, fn: () => PromiseLike<unknown>): Promise<this> {
		const originalValue = this.#currentContributor
		this.#currentContributor = contributor
		try {
			await fn()
		} finally {
			this.#currentContributor = originalValue
		}
		return this
	}

	/**
	 * @param
	 * 	- `contributor` - clear symbol locations contributed by this contributor. Pass in `undefined`
	 * 	to select all symbol locations that don't have a contributor.
	 * 	- `uri` - clear symbol locations associated with this URI.
	 * 	- `predicate` - clear symbol locations matching this predicate
	 */
	@DelayModeSupport()
	clear(
		{ uri, contributor, predicate = () => true }: {
			contributor?: string
			uri?: string
			predicate?: (this: void, data: SymbolLocationEvent) => boolean
		},
	): void {
		const getCaches = (): UriSymbolCache[] => {
			if (contributor) {
				return this.#cache[contributor] ? [this.#cache[contributor]] : []
			} else {
				return Object.values(this.#cache)
			}
		}
		const getPaths = (): SymbolPath[] => {
			const caches = getCaches()
			const sets: Set<string>[] = uri
				? caches.map((cache) => cache[uri] ?? new Set())
				: caches.map((cache) => Object.values(cache)).flat()
			return sets.map((s) => [...s]).flat().map(SymbolPath.fromString)
		}
		const getTables = (): SymbolTable[] => {
			return uri ? [this.#global] : [this.#global]
		}
		const paths = getPaths()
		const tables = getTables()
		for (const table of tables) {
			for (const path of paths) {
				const { symbol } = SymbolUtil.lookupTable(table, path.category, path.path)
				if (!symbol) {
					continue
				}
				this.removeLocationsFromSymbol(
					symbol,
					(data) =>
						(!uri || data.location.uri === uri)
						&& (!contributor || data.location.contributor === contributor)
						&& predicate(data),
				)
			}
			this.trim(table)
		}
	}

	/**
	 * @param uri Optional. The corresponding {@link SymbolStack} of the file will also be looked up if this is specified.
	 *
	 * @returns A {@link LookupResult}
	 */
	lookup(category: AllCategory, path: readonly string[], node?: AstNode): LookupResult
	lookup(category: string, path: readonly string[], node?: AstNode): LookupResult
	lookup(category: string, path: readonly string[], node?: AstNode): LookupResult {
		while (node) {
			if (node.locals) {
				const result = SymbolUtil.lookupTable(node.locals, category, path)
				if (result.symbol) {
					return result
				}
			}
			node = node.parent
		}
		return SymbolUtil.lookupTable(this.global, category, path)
	}

	/**
	 * @param doc A {@link TextDocument} or a string URI. It is used to both check the visibility of symbols and serve as
	 * the location of future entered symbol usages. If a string URI is provided, all `range`s specified while entering
	 * symbol usages latter will be ignored and seen as `[0, 0)`.
	 *
	 * @throws When the queried symbol belongs to another non-existent symbol, or when no contributor is specified.
	 */
	query(
		doc: DocAndNode | TextDocument | string,
		category: AllCategory,
		...path: string[]
	): SymbolQuery
	query(doc: DocAndNode | TextDocument | string, category: string, ...path: string[]): SymbolQuery
	query(
		doc: DocAndNode | TextDocument | string,
		category: string,
		...path: string[]
	): SymbolQuery {
		const uri = SymbolUtil.toUri(doc)
		const { parentSymbol, parentMap, symbol } = this.lookup(
			category,
			path,
			isDocAndNode(doc) ? doc.node : undefined,
		)
		const visible = symbol ? SymbolUtil.isVisible(symbol, uri) : true
		return new SymbolQuery({
			category,
			doc,
			contributor: this.#currentContributor,
			map: visible ? parentMap : undefined,
			parentSymbol,
			path,
			symbol: visible ? symbol : undefined,
			util: this,
		})
	}

	getVisibleSymbols(category: AllCategory, uri?: string): SymbolMap
	getVisibleSymbols(category: string, uri?: string): SymbolMap
	getVisibleSymbols(category: string, uri?: string): SymbolMap {
		const map = this.lookup(category, [], undefined).parentMap ?? undefined

		return SymbolUtil.filterVisibleSymbols(uri, map)
	}

	getScopedSymbols(category: string, doc: DocAndNode, path: readonly string[] = []): SymbolMap {
		const symbols = { ...this.query(doc.doc, category, ...path).visibleMembers }
		const tables: SymbolTable[] = []
		let node: AstNode | undefined = doc.node
		while (node) {
			if (node.locals) {
				tables.push(node.locals)
			}
			node = node.parent
		}
		for (const table of tables.reverse()) {
			const result = SymbolUtil.lookupTable(table, category, path)
			Object.assign(symbols, path.length ? result.symbol?.members : table[category])
		}
		return symbols
	}

	static toUri(uri: DocAndNode | TextDocument | string): string {
		if (typeof uri === 'string') {
			return uri
		}
		if (isDocAndNode(uri)) {
			return uri.doc.uri
		}
		return uri.uri
	}

	/**
	 * @see {@link SymbolUtil.trimMap}
	 */
	@DelayModeSupport()
	trim(table: SymbolTable): void {
		const trimSymbol = (symbol: Symbol | undefined) => {
			if (!symbol) {
				return
			}
			if (SymbolUtil.isTrimmable(symbol)) {
				delete symbol.parentMap[symbol.identifier]
				this.emit('symbolRemoved', { symbol })
				trimSymbol(symbol.parentSymbol)
			}
		}
		for (const pathString of this.#trimmableSymbols) {
			const path = SymbolPath.fromString(pathString)
			const { symbol } = SymbolUtil.lookupTable(table, path.category, path.path)
			trimSymbol(symbol)
		}
	}

	@DelayModeSupport()
	removeLocationsFromSymbol(
		symbol: Symbol,
		predicate: (this: void, data: SymbolLocationEvent) => boolean,
	): void {
		const locatedIsotopes = new Set(
			(symbol.isotopes ?? []).filter(isotope =>
				SymbolUsageTypes.some(type => isotope[type]?.length)
			),
		)
		for (const owner of [symbol, ...(symbol.isotopes ?? [])]) {
			for (const type of SymbolUsageTypes) {
				owner[type] = owner[type]?.filter(location => {
					if (!predicate({ location, symbol, type })) {
						return true
					}
					this.emit('symbolLocationRemoved', { symbol, type, location })
					return false
				})
			}
		}
		this.reconcileDocUsages(symbol)
		if (symbol.isotopes) {
			symbol.isotopes = symbol.isotopes.filter(isotope =>
				!locatedIsotopes.has(isotope) || SymbolUsageTypes.some(type => isotope[type]?.length)
			)
		}
	}

	/**
	 * Enters a symbol into a symbol map. If there is already a symbol with the specified identifier under the map,
	 * it will be amended with the information provided in `addition`. Otherwise, a new symbol with that identifier
	 * will be created.
	 *
	 * @param map The map where this symbol will be entered into.
	 * @param category The category of this symbol.
	 * @param identifier The identifier of this symbol.
	 * @param addition The metadata and usage that will be amended onto this symbol if it already exists, or
	 * to create the symbol if it doesn't exist yet.
	 * @param doc The `TextDocument` where this symbol belongs to.
	 * @param isUriBinding Whether this entering is done by a URI binder or not.
	 *
	 * @returns The created/amended symbol.
	 */
	enterMap(
		parentSymbol: Symbol | undefined,
		map: SymbolMap,
		category: AllCategory,
		path: readonly string[],
		identifier: string,
		addition: SymbolAddition,
		doc: TextDocument,
		contributor: string | undefined,
	): Symbol
	enterMap(
		parentSymbol: Symbol | undefined,
		map: SymbolMap,
		category: string,
		path: readonly string[],
		identifier: string,
		addition: SymbolAddition,
		doc: TextDocument,
		contributor: string | undefined,
	): Symbol
	enterMap(
		parentSymbol: Symbol | undefined,
		map: SymbolMap,
		category: string,
		path: readonly string[],
		identifier: string,
		addition: SymbolAddition,
		doc: TextDocument,
		contributor: string | undefined,
	): Symbol {
		let ans = map[identifier]
		if (ans) {
			this.amendSymbol(ans, addition, doc, contributor)
		} else {
			ans = this.createSymbol(
				category,
				parentSymbol,
				map,
				path,
				identifier,
				addition,
				doc,
				contributor,
			)
		}
		if (addition.usage?.fromDocDeclaration) {
			this.reconcileDocUsages(ans)
		}
		this.emit('symbolAmended', { symbol: ans })
		return ans
	}

	/**
	 * @returns A {@link LookupResult}
	 */
	static lookupTable(
		table: SymbolTable,
		category: AllCategory,
		path: readonly string[],
	): LookupResult
	static lookupTable(table: SymbolTable, category: string, path: readonly string[]): LookupResult
	static lookupTable(table: SymbolTable, category: string, path: readonly string[]): LookupResult {
		let parentMap: SymbolMap | undefined = table[category]
		let parentSymbol: Symbol | undefined
		let symbol: Symbol | undefined
		for (let i = 0; i < path.length; i++) {
			symbol = parentMap?.[path[i]]
			if (!symbol) {
				if (i !== path.length - 1) {
					parentSymbol = undefined
					parentMap = undefined
				}
				break
			}
			if (i === path.length - 1) {
				break
			}
			parentSymbol = symbol
			parentMap = symbol.members
		}
		return { parentSymbol, parentMap, symbol }
	}

	/**
	 * @param tables Should be ordered from global to the toppest block.
	 *
	 * @returns A {@link LookupResult}
	 */
	static lookupTables(
		tables: SymbolTable[],
		category: AllCategory,
		path: readonly string[],
	): LookupResult
	static lookupTables(
		tables: SymbolTable[],
		category: string,
		path: readonly string[],
	): LookupResult
	static lookupTables(
		tables: SymbolTable[],
		category: string,
		path: readonly string[],
	): LookupResult {
		let parentMap: SymbolMap | undefined
		let parentSymbol:
			| Symbol
			| undefined

		// Traverse from the last table to the first one.
		for (let i = tables.length - 1; i >= 0; i--) {
			const table = tables[i]
			const result = this.lookupTable(table, category, path)
			if (result.symbol) {
				return result
			}
			if (!parentSymbol && !parentMap && (result.parentSymbol || result.parentMap)) {
				parentSymbol = result.parentSymbol
				parentMap = result.parentMap
			}
		}

		return { parentSymbol, parentMap, symbol: undefined }
	}

	createSymbol(
		category: string,
		parentSymbol: Symbol | undefined,
		parentMap: SymbolMap,
		path: readonly string[],
		identifier: string,
		addition: SymbolAddition,
		doc: TextDocument,
		contributor: string | undefined,
	): Symbol {
		const ans = (parentMap[identifier] = {
			category,
			identifier,
			...(parentSymbol ? { parentSymbol } : {}),
			parentMap,
			path,
			...addition.data,
		})
		this.amendSymbolMetadata(ans, addition.data)
		this.emit('symbolCreated', { symbol: ans })
		this.amendSymbolUsage(ans, addition.usage, doc, contributor)
		return ans
	}

	amendSymbol(
		symbol: Symbol,
		addition: SymbolAddition,
		doc: TextDocument,
		contributor: string | undefined,
	): void {
		this.amendSymbolMetadata(symbol, addition.data)
		this.amendSymbolUsage(symbol, addition.usage, doc, contributor)
	}

	/** Create or update one isotope by identifier */
	writeIsotope(
		symbol: Symbol,
		identifier: string,
		addition: SymbolIsotopeAddition,
		doc: TextDocument,
		contributor: string | undefined,
	): SymbolIsotope {
		if (addition.data && 'scope' in addition.data && addition.data.scope === undefined) {
			throw new Error('An isotope scope cannot be undefined.')
		}
		symbol = contextualSymbols.get(symbol) ?? symbol
		let isotope = symbol.isotopes?.find(value => value.identifier === identifier)
		if (!isotope) {
			if (addition.data?.scope === undefined) {
				throw new Error('Creating an isotope requires a scope.')
			}
			isotope = { identifier, scope: addition.data.scope }
			;(symbol.isotopes ??= []).push(isotope)
		}
		Object.assign(isotope, addition.data)
		this.amendSymbolUsage(symbol, addition.usage, doc, contributor, isotope)
		if (addition.usage?.node) {
			addition.usage.node.symbol = symbol
		}
		if (addition.usage?.fromDocDeclaration) {
			this.reconcileDocUsages(symbol)
		}
		return isotope
	}

	reconcileDocUsages(symbol: Symbol): void {
		const isotopes = symbol.isotopes ?? []
		const expired = new Set(
			isotopes.filter(isotope =>
				isotope.docDeclaration
				&& !isotope.declaration?.some(location => location.fromDocDeclaration)
			),
		)
		const active = isotopes.filter(isotope => !expired.has(isotope))
		const publicDoc = symbol.declaration?.some(location => location.fromDocDeclaration)
		const owners = [symbol, ...isotopes]
		symbol.isotopes = active.length ? active : undefined
		this.reconcileFileDefinitions(symbol, owners, [
			...(publicDoc ? [symbol] : []),
			...active.filter(isotope =>
				isotope.declaration?.some(location => location.fromDocDeclaration)
			),
		])
		for (const owner of owners) {
			for (const type of SymbolUsageTypes) {
				const locations = owner[type]
				if (!locations) {
					continue
				}
				owner[type] = locations.filter(location => {
					if (location.fromFile || !location.originalUsageType) {
						return true
					}
					const isotope = SymbolUtil.selectIsotope(symbol, location.uri)
					const target = isotope?.declaration?.some(value => value.fromDocDeclaration)
						? isotope
						: symbol
					const targetType = location.originalUsageType === 'definition'
							&& (target !== symbol || publicDoc)
						? 'implementation'
						: location.originalUsageType
					if (target === owner && targetType === type) {
						return true
					}
					;(target[targetType] ??= []).push(location)
					this.emit('symbolLocationRemoved', { symbol, type, location })
					this.emit('symbolLocationCreated', { symbol, type: targetType, location })
					return false
				})
			}
		}
		if (active.some(isotope => isotope.docDeclaration) || expired.size) {
			const hasBaseDeclaration = !!(symbol.declaration?.length || symbol.definition?.length)
			symbol.visibility = hasBaseDeclaration
				? SymbolVisibility.Public
				: SymbolVisibility.Restricted
			if (!hasBaseDeclaration) {
				delete symbol.desc
				delete symbol.data
			}
		}
	}

	/** Associate file definitions with its every doc declaration */
	private reconcileFileDefinitions(
		symbol: Symbol,
		owners: (Symbol | SymbolIsotope)[],
		declarations: (Symbol | SymbolIsotope)[],
	): void {
		// Ignore mcdoc symbols
		if (symbol.category === 'mcdoc') {
			return
		}
		const definitions = new Map<string, SymbolLocation>()
		const keyOf = (location: SymbolLocation): string =>
			JSON.stringify([location.uri, location.contributor, location.range, location.fullRange])
		for (const owner of owners) {
			for (const type of SymbolUsageTypes) {
				for (const location of owner[type] ?? []) {
					if (location.fromFile) {
						definitions.set(keyOf(location), location)
					}
				}
			}
		}
		if (!definitions.size) {
			return
		}
		const targets = declarations.length ? declarations : [symbol]
		const targetUsageType = declarations.length ? 'implementation' : 'definition'
		const retained = new Map<Symbol | SymbolIsotope, Set<string>>()
		for (const owner of owners) {
			const keys = new Set<string>()
			retained.set(owner, keys)
			for (const type of SymbolUsageTypes) {
				const locations = owner[type]
				if (!locations) {
					continue
				}
				owner[type] = locations.filter(location => {
					if (!location.fromFile) {
						return true
					}
					const key = keyOf(location)
					if (targets.includes(owner) && type === targetUsageType && !keys.has(key)) {
						keys.add(key)
						return true
					}
					this.emit('symbolLocationRemoved', { symbol, type, location })
					return false
				})
			}
		}
		for (const owner of targets) {
			for (const [key, location] of definitions) {
				if (!retained.get(owner)?.has(key)) {
					;(owner[targetUsageType] ??= []).push(location)
					this.emit('symbolLocationCreated', { symbol, type: targetUsageType, location })
				}
			}
		}
	}

	private amendSymbolMetadata(
		symbol: Symbol,
		addition: SymbolAddition['data'],
	): void {
		if (addition) {
			if ('visibility' in addition) {
				// Visibility changes are only accepted if the change wouldn't result in the
				// symbol being stored in a different symbol table.
				const inGlobalTable = (v: SymbolVisibility | undefined) =>
					v === undefined || v === SymbolVisibility.Public || v === SymbolVisibility.Restricted
				if (
					symbol.visibility === addition.visibility
					|| (inGlobalTable(symbol.visibility) && inGlobalTable(addition.visibility))
				) {
					symbol.visibility = addition.visibility
				} else {
					throw new Error(
						`Cannot change visibility from ${symbol.visibility} to ${addition.visibility}: ${
							JSON.stringify(SymbolPath.fromSymbol(symbol))
						}`,
					)
				}
			}
			if (symbol.visibility === SymbolVisibility.Restricted) {
				delete symbol.desc
				delete symbol.data
				for (const type of SymbolUsageTypes) {
					for (const location of symbol[type] ?? []) {
						this.emit('symbolLocationRemoved', { symbol, type, location })
					}
					delete symbol[type]
				}
			}

			if (symbol.visibility !== SymbolVisibility.Restricted) {
				if ('data' in addition) {
					symbol.data = addition.data
				}
				if ('desc' in addition) {
					symbol.desc = addition.desc
				}
			}
			if (addition.relations && Object.keys(addition.relations).length) {
				symbol.relations ??= {}
				for (const relationship of Object.keys(addition.relations)) {
					symbol.relations[relationship] = addition.relations[relationship]
				}
			}
			if ('subcategory' in addition) {
				symbol.subcategory = addition.subcategory
			}
		}
	}

	private amendSymbolUsage(
		symbol: Symbol,
		addition: SymbolAddition['usage'],
		doc: TextDocument,
		contributor: string | undefined,
		owner: Symbol | SymbolIsotope = symbol,
	): void {
		if (addition) {
			if (owner === symbol && symbol.visibility === SymbolVisibility.Restricted) {
				return
			}
			const type = addition.type ?? 'reference'
			const arr = (owner[type] ??= [])
			const range = Range.get(
				(SymbolAdditionUsageWithNode.is(addition) ? addition.node : addition.range) ?? 0,
			)
			const location = SymbolLocation.create(doc, range, addition.fullRange, contributor, {
				accessType: addition.accessType,
				skipRenaming: addition.skipRenaming,
				...(addition.fromDocDeclaration ? { fromDocDeclaration: true } : {}),
				...(addition.fromFile ? { fromFile: true } : {}),
				...(addition.originalUsageType
					? { originalUsageType: addition.originalUsageType }
					: {}),
			})
			if (!doc.uri.startsWith('file:')) {
				delete location.range
				delete location.posRange
				delete location.fullRange
				delete location.fullPosRange
			}
			arr.push(location)
			this.emit('symbolLocationCreated', { symbol, type, location })
		}
	}

	/**
	 * @returns The ultimate symbol being pointed by the passed-in `symbol`'s alias.
	 */
	resolveAlias(symbol: Symbol | undefined): Symbol | undefined {
		symbol = symbol ? contextualSymbols.get(symbol) ?? symbol : undefined
		return symbol?.relations?.aliasOf
			? this.resolveAlias(
				this.lookup(symbol.relations.aliasOf.category, symbol.relations.aliasOf.path).symbol,
			)
			: symbol
	}

	static filterVisibleSymbols(uri: string | undefined, map: SymbolMap = {}): SymbolMap {
		const ans: SymbolMap = {}

		for (const [identifier, symbol] of Object.entries(map)) {
			if (SymbolUtil.isVisible(symbol, uri)) {
				ans[identifier] = symbol
			}
		}

		return ans
	}

	static isTrimmable(symbol: Symbol): boolean {
		return (!Object.keys(symbol.members ?? {}).length
			&& !symbol.declaration?.length
			&& !symbol.definition?.length
			&& !symbol.implementation?.length
			&& !symbol.reference?.length
			&& !symbol.typeDefinition?.length
			&& !symbol.isotopes?.length)
	}

	/** Select the effective isotope given symbol and URI. */
	static selectIsotope(symbol: Symbol, uri: string | undefined): SymbolIsotope | undefined {
		if (!uri) {
			return undefined
		}
		const namespace = /\/(?:data|assets)\/([^/]+)\//.exec(uri)?.[1] // FIXME: namespace extraction not covering all cases
		let selected: SymbolIsotope | undefined
		for (const isotope of symbol.isotopes ?? []) {
			if (isotope.scope === SymbolIsotopeScope.Local) {
				continue
			}
			if (isotope.namespace?.length && !isotope.namespace.includes(namespace ?? '')) {
				continue
			}
			const patterns = isotope.visibleWithin
			if (!patterns?.length) {
				continue
			}
			let cached = isotopeMatchers.get(isotope)
			// Compare a snapshot so in-place edits also invalidate the matcher.
			if (
				!cached || cached.patterns.length !== patterns.length
				|| patterns.some((pattern, index) => pattern !== cached!.patterns[index])
			) {
				cached = { patterns: [...patterns], match: picomatch(patterns, { dot: true }) }
				isotopeMatchers.set(isotope, cached)
			}
			if (!cached.match(uri)) {
				continue
			}
			if (
				!selected || isotope.scope < selected.scope
				|| (isotope.scope === selected.scope
					&& (isotope.overrideLevel ?? 0) > (selected.overrideLevel ?? 0))
			) {
				selected = isotope
			}
		}
		return selected
	}

	/** @returns A contextual view of the symbol from the given URI. */
	static viewFromContext(symbol: Symbol | undefined, uri: string | undefined): Symbol | undefined {
		if (!symbol) {
			return undefined
		}
		symbol = contextualSymbols.get(symbol) ?? symbol
		const isotope = this.selectIsotope(symbol, uri)
		if (!isotope) {
			return symbol.visibility === SymbolVisibility.Restricted ? undefined : symbol
		}
		const view: Symbol = { ...symbol, desc: isotope.desc, data: isotope.data }
		for (const usage of SymbolUsageTypes) {
			view[usage] = isotope[usage]
		}
		contextualSymbols.set(view, symbol)
		return view
	}

	static isVisible(symbol: Symbol, uri: string): boolean
	static isVisible(symbol: Symbol, uri: string | undefined): boolean | undefined
	static isVisible(symbol: Symbol, uri: string | undefined): boolean | undefined {
		symbol = contextualSymbols.get(symbol) ?? symbol
		return symbol.visibility !== SymbolVisibility.Restricted || !!this.selectIsotope(symbol, uri)
	}

	/**
	 * @returns If the symbol has declarations or definitions.
	 */
	static isDeclared(symbol: DeepReadonly<Symbol> | undefined): boolean {
		return !!(symbol?.declaration?.length || symbol?.definition?.length)
	}
	/**
	 * @returns If the symbol has definitions, or declarations and implementations.
	 */
	static isDefined(symbol: DeepReadonly<Symbol> | undefined): symbol is Symbol {
		return !!(symbol?.definition?.length
			|| (symbol?.definition?.length && symbol?.implementation?.length))
	}
	/**
	 * @returns If the symbol has implementations or definitions.
	 */
	static isImplemented(symbol: DeepReadonly<Symbol> | undefined): symbol is Symbol {
		return !!(symbol?.implementation?.length || symbol?.definition?.length)
	}
	/**
	 * @returns If the symbol has references.
	 */
	static isReferenced(symbol: DeepReadonly<Symbol> | undefined): symbol is Symbol {
		return !!symbol?.reference?.length
	}
	/**
	 * @returns If the symbol has type definitions.
	 */
	static isTypeDefined(symbol: DeepReadonly<Symbol> | undefined): symbol is Symbol {
		return !!symbol?.typeDefinition?.length
	}

	/**
	 * @throws If the symbol does not have any declarations or definitions.
	 */
	static getDeclaredLocation(symbol: DeepReadonly<Symbol>): SymbolLocation {
		return (symbol.declaration?.[0] ?? symbol.definition?.[0] ?? (() => {
			throw new Error(
				`Cannot get declared location of ${JSON.stringify(SymbolPath.fromSymbol(symbol))}`,
			)
		})())
	}

	static forEachSymbolInMap(map: SymbolMap, fn: (symbol: Symbol) => unknown): void {
		for (const symbol of Object.values(map!)) {
			fn(symbol)
			if (symbol.members) {
				this.forEachSymbolInMap(symbol.members, fn)
			}
		}
	}

	static forEachSymbol(table: SymbolTable, fn: (symbol: Symbol) => unknown): void {
		for (const map of Object.values(table)) {
			this.forEachSymbolInMap(map!, fn)
		}
	}

	static forEachLocationOfSymbol(
		symbol: Symbol,
		fn: (data: { type: SymbolUsageType; location: SymbolLocation }) => unknown,
	): void {
		for (const owner of [symbol, ...(symbol.isotopes ?? [])]) {
			for (const type of SymbolUsageTypes) {
				owner[type]?.forEach((location) => fn({ type, location }))
			}
		}
	}

	static isVisibilityInGlobal(v: SymbolVisibility | undefined) {
		return (v === undefined || v === SymbolVisibility.Public || v === SymbolVisibility.Restricted)
	}

	static areVisibilitiesCompatible(
		v1: SymbolVisibility | undefined,
		v2: SymbolVisibility | undefined,
	) {
		return ((this.isVisibilityInGlobal(v1) && this.isVisibilityInGlobal(v2))
			|| (v1 === SymbolVisibility.Block && v2 === SymbolVisibility.Block)
			|| (v1 === SymbolVisibility.File && v2 === SymbolVisibility.File))
	}
}

export interface SymbolIsotopeAddition {
	data?: Partial<Omit<SymbolIsotope, SymbolUsageType | 'identifier'>>
	usage?: SymbolAdditionUsage
}

interface SymbolAddition {
	data?: SymbolMetadata
	usage?: SymbolAdditionUsage
}
type SymbolAdditionUsage = SymbolAdditionUsageWithRange | SymbolAdditionUsageWithNode
interface SymbolAdditionUsageBase extends SymbolLocationMetadata {
	/**
	 * The type of this usage. Use `definition` when the usage consists both a `declaration` and an `implementation`.
	 */
	type?: SymbolUsageType
	/**
	 * @see {@link SymbolLocation.fullRange}
	 */
	fullRange?: RangeLike
}
interface SymbolAdditionUsageWithRange extends SymbolAdditionUsageBase {
	/**
	 * The range of this symbol usage. It should contain exactly the symbol identifier itself, with no
	 * whitespaces whatsoever included.
	 *
	 * This property is ignored when the specified document's URI is not of `file:` schema. It is also ignored and
	 * set to `[0, 0)` if only a file URI, instead of a {@link TextDocument}, is provided.
	 *
	 * Please use `node` instead of this property whenever it makes sense. Learn more at the documentation
	 * for that property.
	 *
	 * If neither `node` nor `range` is provided, the range falls back to `[0, 0)`.
	 */
	range?: RangeLike
	node?: undefined
}
namespace SymbolAdditionUsageWithRange {
	/* istanbul ignore next */
	export function is(
		usage: SymbolAdditionUsage | undefined,
	): usage is SymbolAdditionUsageWithRange {
		return !!usage?.range
	}
}
interface SymbolAdditionUsageWithNode extends SymbolAdditionUsageBase {
	/**
	 * The node associated with this symbol usage. It should contain exactly the symbol identifier itself, with no
	 * wrapper nodes whatsoever included.
	 *
	 * This property is ignored when the specified document's URI is not of `file:` schema. It is also ignored and
	 * treated as `range: [0, 0)` if only a file URI, instead of a {@link TextDocument}, is provided.
	 *
	 * Either this property or `range` could be used to represent the range of this usage.
	 *
	 * However, using `node` also have the benefit of auto setting `node.symbol` to the queried symbol.
	 * It is recommended to use `node` whenever applicable.
	 *
	 * If neither `node` nor `range` is provided, the range falls back to `[0, 0)`.
	 */
	node?: AstNode
	range?: undefined
}
namespace SymbolAdditionUsageWithNode {
	/* istanbul ignore next */
	export function is(
		usage: SymbolAdditionUsage | undefined,
	): usage is SymbolAdditionUsageWithNode {
		return !!usage?.node
	}
}

/**
 * A stack of {@link SymbolTable}s. The first element represents the `File` visibility scope,
 * which is accessible by any later elements but not saved to the global `SymbolTable`.
 * Later elements represent different levels of `Block` visibility scopes.
 */
export type SymbolStack = [SymbolTable, ...SymbolTable[]]

type QueryCallback<S extends Symbol | undefined = Symbol | undefined> = (
	this: SymbolQuery,
	symbol: S,
	query: SymbolQuery,
) => unknown
type QueryMemberCallback = (this: void, query: SymbolQuery) => unknown

/* istanbul ignore next */
export class SymbolQuery {
	readonly category: string
	path: readonly string[]
	readonly #doc: TextDocument
	readonly #node:
		| AstNode
		| undefined
	/**
	 * If only a string URI (instead of a {@link TextDocument}) is provided when constructing this class.
	 *
	 * If this is `true`, {@link SymbolAdditionUsageWithRange.range} is ignored and treated as `[0, 0)` when entering symbols through this class.
	 */
	readonly #createdWithUri?: boolean
	readonly #currentContributor: string | undefined
	#hasTriggeredIf = false
	/**
	 * The map where the queried symbol is stored. `undefined` if the map hasn't been created yet.
	 */
	#map: SymbolMap | undefined
	#parentSymbol:
		| Symbol
		| undefined
	/**
	 * The queried symbol. `undefined` if the symbol hasn't been created yet.
	 */
	#symbol:
		| Symbol
		| undefined
	/**
	 * The {@link SymbolUtil} where this query was created.
	 */
	util: SymbolUtil

	get symbol(): Symbol | undefined {
		return this.#symbol
	}

	get visibleMembers(): SymbolMap {
		return SymbolUtil.filterVisibleSymbols(
			this.#doc.uri,
			this.path.length === 0 ? this.#map : this.#symbol?.members,
		)
	}

	constructor(
		{ category, contributor, doc, map, parentSymbol, path, symbol, util }: {
			category: string
			contributor: string | undefined
			doc: DocAndNode | TextDocument | string
			map: SymbolMap | undefined
			parentSymbol: Symbol | undefined
			path: readonly string[]
			symbol: Symbol | undefined
			util: SymbolUtil
		},
	) {
		this.category = category
		this.path = path

		if (typeof doc === 'string') {
			doc = TextDocument.create(doc, '', 0, '')
			this.#createdWithUri = true
		} else if (isDocAndNode(doc)) {
			this.#node = doc.node
			doc = doc.doc
		}
		this.#doc = doc
		this.#currentContributor = contributor
		this.#map = map
		this.#parentSymbol = parentSymbol
		this.#symbol = symbol
		this.util = util
	}

	heyGimmeDaSymbol() {
		return this.#symbol
	}

	getData<T>(predicate: (this: void, value: unknown) => value is T): T | undefined {
		const data = this.#symbol?.data
		return predicate(data) ? data : undefined
	}

	with(fn: QueryMemberCallback): this {
		fn(this)
		return this
	}

	if(
		predicate: (this: void, symbol: Symbol | undefined) => symbol is undefined,
		fn: QueryCallback<undefined>,
	): this
	if(
		predicate: (this: void, symbol: Symbol | undefined) => symbol is Symbol,
		fn: QueryCallback<Symbol>,
	): this
	if(predicate: QueryCallback, fn: QueryCallback): this
	if(predicate: QueryCallback, fn: QueryCallback<any>): this {
		if (predicate.call(this, this.#symbol, this)) {
			fn.call(this, this.#symbol, this)
			this.#hasTriggeredIf = true
		}
		return this
	}

	/**
	 * Calls `fn` if the queried symbol does not exist.
	 */
	ifUnknown(fn: QueryCallback<undefined>): this {
		return this.if((s) => s === undefined, fn as QueryCallback)
	}

	/**
	 * Calls `fn` if the queried symbol exists (i.e. has any of declarations/definitions/implementations/references/typeDefinitions).
	 */
	ifKnown(fn: QueryCallback<Symbol>): this {
		return this.if((s) => s !== undefined, fn as QueryCallback)
	}

	/**
	 * Calls `fn` if the queried symbol has declarations or definitions.
	 */
	ifDeclared(fn: QueryCallback<Symbol>): this {
		return this.if((s): s is Symbol => SymbolUtil.isDeclared(s), fn)
	}

	/**
	 * Calls `fn` if the queried symbol has definitions, or both declarations and implementations.
	 */
	ifDefined(fn: QueryCallback<Symbol>): this {
		return this.if(SymbolUtil.isDefined, fn)
	}

	/**
	 * Calls `fn` if the queried symbol has implementations or definitions.
	 */
	ifImplemented(fn: QueryCallback<Symbol>): this {
		return this.if(SymbolUtil.isImplemented, fn)
	}

	/**
	 * Calls `fn` if the queried symbol has references.
	 */
	ifReferenced(fn: QueryCallback<Symbol>): this {
		return this.if(SymbolUtil.isReferenced, fn)
	}

	/**
	 * Calls `fn` if the queried symbol has type definitions.
	 */
	ifTypeDefined(fn: QueryCallback<Symbol>): this {
		return this.if(SymbolUtil.isTypeDefined, fn)
	}

	/**
	 * Calls `fn` if none of the former `if` conditions are met.
	 */
	else(fn: QueryCallback): this {
		if (!this.#hasTriggeredIf) {
			fn.call(this, this.#symbol, this)
		}
		return this
	}

	/**
	 * Enters the queried symbol if none of the former `if` conditions are met.
	 */
	elseEnter(symbol: SymbolAddition): this {
		return this.else(() => this.enter(symbol as any))
	}

	/**
	 * Resolves the queried symbol if it is an alias and if none of the former `if` conditions are met.
	 *
	 * @throws If the current symbol points to an non-existent symbol.
	 */
	elseResolveAlias(): this {
		return this.else(() => this.resolveAlias())
	}

	@DelayModeSupport((self: SymbolQuery) => self.util)
	private _enter(addition: SymbolAddition): void {
		this.enterImmediately(addition)
	}

	private enterImmediately(addition: SymbolAddition): void {
		/**
		 * Get a proper visibility from the addition:
		 * * If the visibility is specified, use it.
		 * * If the visibility is `undefined`, use the visibility of the symbol, or `Public` if unapplicable.
		 */
		const getAdditionVisibility = (addition: SymbolAddition): SymbolVisibility => {
			return (addition.data?.visibility ?? this.#symbol?.visibility ?? SymbolVisibility.Public)
		}

		const getMap = (addition: SymbolAddition): SymbolMap => {
			const additionVisibility = getAdditionVisibility(addition)
			if (
				this.#map
				&& SymbolUtil.areVisibilitiesCompatible(additionVisibility, this.#symbol?.visibility)
			) {
				return this.#map
			}
			if (this.path.length > 1) {
				if (this.#parentSymbol) {
					if (
						!SymbolUtil.areVisibilitiesCompatible(
							additionVisibility,
							this.#parentSymbol.visibility,
						)
					) {
						throw new Error(
							`Cannot enter member “${this.getPath()}” of ${
								SymbolFormatter.stringifyVisibility(additionVisibility)
							} visibility to parent of ${
								SymbolFormatter.stringifyVisibility(this.#parentSymbol.visibility)
							} visibility`,
						)
					}
					return (this.#parentSymbol.members ??= {})
				}
			} else {
				let table: SymbolTable | undefined
				if (SymbolUtil.isVisibilityInGlobal(additionVisibility)) {
					table = this.util.global
				} else if (additionVisibility === SymbolVisibility.File) {
					if (!this.#node) {
						throw new Error(
							`Cannot enter “${this.getPath()}” with ${
								SymbolFormatter.stringifyVisibility(additionVisibility)
							} visibility as no node is supplied`,
						)
					}
					let node: AstNode | undefined = this.#node
					while (node) {
						if (node.type === 'file') {
							table = node.locals
							break
						}
						node = node.parent
					}
					if (!table) {
						throw new Error(
							`Cannot enter “${this.getPath()}” with ${
								SymbolFormatter.stringifyVisibility(additionVisibility)
							} visibility as no file node is supplied`,
						)
					}
				} else {
					if (!this.#node) {
						throw new Error(
							`Cannot enter “${this.getPath()}” with ${
								SymbolFormatter.stringifyVisibility(additionVisibility)
							} visibility as no node is supplied`,
						)
					}
					let node: AstNode | undefined = this.#node
					while (node) {
						if (node.locals) {
							table = node.locals
							break
						}
						node = node.parent
					}
					if (!table) {
						throw new Error(
							`Cannot enter “${this.getPath()}” with ${
								SymbolFormatter.stringifyVisibility(additionVisibility)
							} visibility as no node with locals is supplied`,
						)
					}
				}
				// TODO: Move part of symbol from global to table.
				return (table[this.category] ??= {})
			}
			throw new Error(`Cannot create the symbol map for “${this.getPath()}”`)
		}

		// Treat `usage.range` as `[0, 0)` if this class was constructed with a string URI (instead of a `TextDocument`).
		if (this.#createdWithUri && SymbolAdditionUsageWithRange.is(addition.usage)) {
			addition.usage.range = Range.create(0, 0)
		}

		this.#map = getMap(addition)
		this.#symbol = this.util.enterMap(
			this.#parentSymbol,
			this.#map,
			this.category,
			this.path,
			this.path[this.path.length - 1],
			addition,
			this.#doc,
			this.#currentContributor,
		)
		if (addition.usage?.node) {
			addition.usage.node.symbol = this.#symbol
		}
	}

	/**
	 * Enters the queried symbol.
	 *
	 * @throws If the parent of this symbol doesn't exist either.
	 */
	enter(addition: SymbolAddition): this {
		this._enter(addition)
		return this
	}

	/** Bind a symbol defined by the file itself, rather than its contents. */
	enterFileDefinition(addition: SymbolAddition): this {
		this._enterFileDefinition(addition)
		return this
	}

	@DelayModeSupport((self: SymbolQuery) => self.util)
	private _enterFileDefinition(addition: SymbolAddition): void {
		const raw = this.util.lookup(this.category, this.path, this.#node).symbol
		this.#symbol = raw
		if (raw) {
			this.#map = raw.parentMap
		}
		const usage: SymbolAdditionUsage = {
			...addition.usage,
			type: 'definition',
			originalUsageType: 'definition',
			fromFile: true,
		}
		if (this.#createdWithUri && SymbolAdditionUsageWithRange.is(usage)) {
			usage.range = Range.create(0, 0)
		}
		const isotope = raw?.isotopes?.find(value =>
			value.declaration?.some(location => location.fromDocDeclaration)
		)
		if (raw && isotope) {
			this.util.amendSymbol(raw, { data: addition.data }, this.#doc, this.#currentContributor)
			this.util.writeIsotope(
				raw,
				isotope.identifier,
				{
					usage: { ...usage, type: 'implementation' },
				},
				this.#doc,
				this.#currentContributor,
			)
		} else {
			this.enterImmediately({
				...addition,
				data: raw?.visibility === SymbolVisibility.Restricted
					? { ...addition.data, visibility: SymbolVisibility.Public }
					: addition.data,
				usage,
			})
		}
		this.util.reconcileDocUsages(this.#symbol!)
	}

	enterCommand(addition: SymbolAddition): this {
		this._enterCommand(addition)
		return this
	}

	@DelayModeSupport((self: SymbolQuery) => self.util)
	private _enterCommand(addition: SymbolAddition): void {
		const raw = this.util.lookup(this.category, this.path, this.#node).symbol
		const isotope = raw && SymbolUtil.selectIsotope(raw, this.#doc.uri)
		const originalType = addition.usage?.type ?? 'reference'
		const usage = { ...addition.usage, originalUsageType: originalType }
		if (raw && isotope?.declaration?.some(location => location.fromDocDeclaration)) {
			this.util.writeIsotope(
				raw,
				isotope.identifier,
				{
					usage: {
						...usage,
						type: originalType === 'definition' ? 'implementation' : originalType,
					},
				},
				this.#doc,
				this.#currentContributor,
			)
			this.#symbol = raw
			this.#map = raw.parentMap
			return
		}
		const publicDoc = raw?.declaration?.some(location => location.fromDocDeclaration)
		this.enterImmediately({
			...addition,
			data: originalType === 'definition' && raw?.visibility === SymbolVisibility.Restricted
				? { ...addition.data, visibility: SymbolVisibility.Public }
				: addition.data,
			usage: {
				...usage,
				type: originalType === 'definition' && publicDoc ? 'implementation' : originalType,
			},
		})
	}

	/** Move base usages covered by the named isotope to the isotope. */
	migrateDefinitions(identifier: string): this {
		this._migrateDefinitions(identifier)
		return this
	}

	@DelayModeSupport((self: SymbolQuery) => self.util)
	private _migrateDefinitions(identifier: string): void {
		const symbol = this.#symbol ?? this.util.lookup(
			this.category,
			this.path,
			this.#node,
		).symbol
		const isotope = symbol?.isotopes?.find(value => value.identifier === identifier)
		if (!symbol || !isotope) {
			throw new Error(`Cannot migrate definitions to unknown isotope “${identifier}”.`)
		}
		let changed = false
		for (
			const [source, target] of [
				['reference', 'reference'],
				['definition', 'implementation'],
			] as const
		) {
			const locations = symbol[source]
			if (!locations) {
				continue
			}
			symbol[source] = locations.filter(location => {
				if (SymbolUtil.selectIsotope(symbol, location.uri) !== isotope) {
					return true
				}
				;(isotope[target] ??= []).push(location)
				this.util.emit('symbolLocationRemoved', { symbol, type: source, location })
				this.util.emit('symbolLocationCreated', { symbol, type: target, location })
				changed = true
				return false
			})
		}
		if (changed) {
			this.util.emit('symbolAmended', { symbol })
		}
	}

	enterIsotope(identifier: string, addition: SymbolIsotopeAddition): this {
		this._enterIsotope(identifier, addition)
		return this
	}

	@DelayModeSupport((self: SymbolQuery) => self.util)
	private _enterIsotope(identifier: string, addition: SymbolIsotopeAddition): void {
		// Earlier delayed writes may have created the symbol since this query was made.
		const current = this.util.lookup(this.category, this.path, this.#node)
		this.#symbol = current.symbol
		if (current.symbol) {
			this.#map = current.symbol.parentMap
		}
		if (!this.#symbol) {
			if (addition.data?.scope === undefined) {
				throw new Error('Creating an isotope requires a scope.')
			}
			this.enterImmediately({ data: { visibility: SymbolVisibility.Restricted } })
		}
		if (this.#createdWithUri && SymbolAdditionUsageWithRange.is(addition.usage)) {
			addition.usage.range = Range.create(0, 0)
		}
		this.util.writeIsotope(
			this.#symbol!,
			identifier,
			addition,
			this.#doc,
			this.#currentContributor,
		)
	}

	/**
	 * Amends the queried symbol if the queried symbol exists (i.e. has any of declarations/definitions/implementations/references/typeDefinitions) and is visible at the current scope.
	 *
	 * This is equivalent to calling
	 * ```typescript
	 * query.ifKnown(function () {
	 * 	this.enter(symbol)
	 * })
	 * ```
	 *
	 * Therefore, if the symbol is successfully amended, `elseX` methods afterwards will **not** be executed.
	 */
	amend(symbol: SymbolAddition): this {
		return this.ifKnown(() => this.enter(symbol as any))
	}

	/**
	 * Resolves this symbol if it exists and is an alias.
	 *
	 * @throws If the current symbol points to an non-existent symbol. The state of this object will not be changed
	 * after the error is thrown.
	 */
	resolveAlias(): this {
		if (this.#symbol) {
			const result = this.util.resolveAlias(this.#symbol)
			if (!result) {
				throw new Error('The current symbol points to an non-existent symbol.')
			}
			this.#symbol = result
			this.#map = result.parentMap
			this.#parentSymbol = result.parentSymbol
			this.path = result.path
		}
		return this
	}

	/**
	 * @param identifier The identifier of the member symbol.
	 * @param fn A callback function where `this` is the member symbol's query result.
	 *
	 * @throws If the current queried symbol doesn't exist.
	 */
	member(identifier: string, fn: QueryMemberCallback): this
	member(doc: TextDocument | string, identifier: string, fn: QueryMemberCallback): this
	member(): this {
		// Handle overloads.
		let doc: TextDocument | string, identifier: string, fn: QueryMemberCallback
		if (arguments.length === 2) {
			// Ensure the member query result will not unknowingly have a dummy TextDocument passed down from this class.
			doc = this.#createdWithUri ? this.#doc.uri : this.#doc
			identifier = arguments[0]
			fn = arguments[1]
		} else {
			doc = arguments[0]
			identifier = arguments[1]
			fn = arguments[2]
		}

		if (this.#symbol === undefined) {
			throw new Error(
				`Tried to query member symbol “${identifier}” from an undefined symbol (path “${
					this.path.join('.')
				}”)`,
			)
		}

		const memberDoc = typeof doc === 'string' && doc === this.#doc.uri && !this.#createdWithUri
			? this.#doc
			: doc
		const memberMap = this.#symbol.members
		const memberSymbol = memberMap?.[identifier]
		const memberQueryResult = new SymbolQuery({
			category: this.category,
			doc: memberDoc,
			contributor: this.#currentContributor,
			map: memberMap,
			parentSymbol: this.#symbol,
			path: [...this.path, identifier],
			symbol: memberSymbol,
			util: this.util,
		})
		fn(memberQueryResult)

		return this
	}

	/**
	 * Do something with this query on each value in a given iterable. The query itself will be included
	 * in the callback function as the second parameter.
	 */
	onEach<T>(values: Iterable<T>, fn: (this: this, value: T, query: this) => unknown): this {
		for (const value of values) {
			fn.call(this, value, this)
		}
		return this
	}

	forEachMember(fn: (this: void, identifier: string, query: SymbolQuery) => unknown): this {
		return this.onEach(
			Object.keys(this.visibleMembers),
			(identifier) => this.member(identifier, (query) => fn(identifier, query)),
		)
	}

	private getPath() {
		return `${this.category}.${this.path.join('/')}`
	}
}

/* istanbul ignore next */
/**
 * A series of methods for converting symbol structures to human-readable outputs. Mostly for debug purposes.
 */
export namespace SymbolFormatter {
	const IndentChar = '+ '

	function assertEqual<T>(a: T, b: T): void {
		if (a !== b) {
			throw new Error(`Assertion error: ${a} !== ${b}`)
		}
	}

	export function stringifySymbolStack(stack: SymbolStack): string {
		return stack.map((table) => stringifySymbolTable(table)).join('\n------------\n')
	}

	export function stringifySymbolTable(table: SymbolTable, indent = ''): string {
		const ans: [string, string][] = []
		for (const category of Object.keys(table)) {
			const map = table[category]!
			ans.push([category, stringifySymbolMap(map, `${indent}${IndentChar}`)])
		}
		return (ans.map((v) => `CATEGORY ${v[0]}\n${v[1]}`).join(`\n${indent}------------\n`)
			|| 'EMPTY TABLE')
	}

	export function stringifySymbolMap(map: SymbolMap | undefined, indent = ''): string {
		if (!map) {
			return 'undefined'
		}
		const ans: string[] = []
		for (const identifier of Object.keys(map)) {
			const symbol: Symbol = map[identifier]!
			assertEqual(identifier, symbol.identifier)
			ans.push(stringifySymbol(symbol, indent))
		}
		return ans.join(`\n${indent}------------\n`)
	}

	export function stringifySymbol(symbol: Symbol | undefined, indent = ''): string {
		if (!symbol) {
			return 'undefined'
		}
		const ans: string[] = []
		assertEqual(symbol.path[symbol.path.length - 1], symbol.identifier)
		ans.push(
			`SYMBOL ${symbol.path.join('.')}`
				+ ` {${symbol.category}${symbol.subcategory ? ` (${symbol.subcategory})` : ''}}`
				+ ` [${stringifyVisibility(symbol.visibility, symbol.visibilityRestriction)}]`,
		)
		if (symbol.data) {
			ans.push(`${IndentChar}data: ${JSON.stringify(symbol.data, bigintJsonNumberReplacer)}`)
		}
		if (symbol.desc) {
			ans.push(`${IndentChar}description: ${symbol.desc}`)
		}
		for (const type of SymbolUsageTypes) {
			if (symbol[type]) {
				ans.push(
					`${IndentChar}${type}:\n${
						symbol[type]!.map((v) => `${indent}${IndentChar.repeat(2)}${JSON.stringify(v)}`)
							.join(`\n${indent}${IndentChar.repeat(2)}------------\n`)
					}`,
				)
			}
		}
		if (symbol.relations) {
			ans.push(`${IndentChar}relations: ${JSON.stringify(symbol.relations)}`)
		}
		if (symbol.members) {
			ans.push(
				`${IndentChar}members:\n${
					stringifySymbolMap(symbol.members, `${indent}${IndentChar.repeat(2)}`)
				}`,
			)
		}
		return ans.map((v) => `${indent}${v}`).join('\n')
	}

	export function stringifyVisibility(
		visibility: SymbolVisibility | undefined,
		visibilityRestriction?: string[],
	) {
		let stringVisibility: string
		// Const enums cannot be indexed even if `--preserveConstEnums` is on: https://github.com/microsoft/TypeScript/issues/31353
		switch (visibility) {
			case SymbolVisibility.Block:
				stringVisibility = 'Block'
				break
			case SymbolVisibility.File:
				stringVisibility = 'File'
				break
			case SymbolVisibility.Restricted:
				stringVisibility = 'Restricted'
				break
			default:
				stringVisibility = 'Public'
				break
		}
		return `${stringVisibility}${
			visibilityRestriction ? ` ${visibilityRestriction.map((v) => `“${v}”`).join(', ')}` : ''
		}`
	}

	export function stringifyLookupResult(result: LookupResult): string {
		return `parentSymbol:
${stringifySymbol(result.parentSymbol, IndentChar)}
parentMap:
${stringifySymbolMap(result.parentMap, IndentChar)}
symbol:
${stringifySymbol(result.symbol, IndentChar)}`
	}
}

/**
 * Make a method support delay mode: if the {@link SymbolUtil} is in delay mode, the actual invocation of the method will be
 * stored to the {@link SymbolUtil._delayedOps} array.
 *
 * The decorated method MUST have return type `void`.
 */
function DelayModeSupport(getUtil: (self: any) => SymbolUtil = (self) => self): MethodDecorator {
	return (_target: Object, _key: string | symbol, descripter: PropertyDescriptor) => {
		const decoratedMethod: (...args: unknown[]) => unknown = descripter.value
		// The `function` syntax is used to preserve `this` context from the decorated method.
		descripter.value = function(this: unknown, ...args: unknown[]) {
			const util = getUtil(this)
			if (util._inDelayMode) {
				util._delayedOps.push(decoratedMethod.bind(this, ...args))
			} else {
				decoratedMethod.apply(this, args)
			}
		}
		return descripter
	}
}

function isDocAndNode(doc: string | TextDocument | DocAndNode): doc is DocAndNode {
	return !!(doc as DocAndNode).doc
}
