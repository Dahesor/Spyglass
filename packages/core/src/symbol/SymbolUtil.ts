import { TextDocument } from 'vscode-languageserver-textdocument'
import { bigintJsonNumberReplacer, type DeepReadonly, EventDispatcher } from '../common/index.js'
import type { AstNode } from '../node/index.js'
import type { RangeLike } from '../source/index.js'
import { Range } from '../source/index.js'
import { GlobalSymbol } from './GlobalSymbol.js'
import { Isotope, type SymbolIsotopeAddition } from './isotope.js'
import { LocalSymbol, type LocalSymbolContext } from './LocalSymbol.js'
import type {
	AllCategory,
	IsotopeScope,
	Symbol,
	SymbolIsotopeProvider,
	SymbolLocationBuiltInContributor,
	SymbolLocationMetadata,
	SymbolMap,
	SymbolMetadata,
	SymbolTable,
	SymbolUsageType,
	SymbolView,
} from './Symbol.js'
import { SymbolLocation, SymbolPath, SymbolUsageTypes } from './Symbol.js'

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
export interface SymbolLocationEvent extends SymbolEvent {
	type: SymbolUsageType
	location: SymbolLocation
}

export interface SymbolClearOptions {
	contributor?: string
	uri?: string
	predicate?: (this: void, data: SymbolLocationEvent) => boolean
}

export class SymbolUtil extends EventDispatcher<{
	symbolCreated: SymbolEvent
	symbolAmended: SymbolEvent
	symbolRemoved: SymbolEvent
	symbolLocationCreated: SymbolLocationEvent
	symbolLocationRemoved: SymbolLocationEvent
}> {
	readonly global: SymbolTable

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

	constructor(
		global: SymbolTable,
		/** @internal */
		_currentContributor?: string,
		/** @internal */
		_inDelayMode = false,
	) {
		super()
		this.global = global
		this.#currentContributor = _currentContributor
		this._inDelayMode = _inDelayMode
		GlobalSymbol.initialize(this)
	}

	/**
	 * @returns A clone of this SymbolUtil that is in delay mode: changes to the symbol table happened in the clone will
	 * not take effect until the {@link SymbolUtil.applyDelayedEdits} method is called on that clone.
	 *
	 * The clone shares the same reference of the global symbol table, meaning that after
	 * `applyDelayedEdits` is called, the original SymbolUtil will also be modified.
	 */
	clone(): SymbolUtil {
		return new SymbolUtil(
			this.global,
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
	 * @param doc A {@link TextDocument} or a string URI. It is used to both check the visibility of symbols and serve as
	 * the location of future entered symbol usages. If a URI is provided, `range` will be ignored and seen as `[0, 0)`.
	 *
	 * @throws When the queried symbol belongs to another non-existent symbol, or when no contributor is specified.
	 */
	query(
		doc: LocalSymbolContext | TextDocument | string,
		category: AllCategory,
		...path: string[]
	): SymbolQuery
	query(
		doc: LocalSymbolContext | TextDocument | string,
		category: string,
		...path: string[]
	): SymbolQuery
	query(
		doc: LocalSymbolContext | TextDocument | string,
		category: string,
		...path: string[]
	): SymbolQuery {
		if (typeof doc !== 'string' && 'doc' in doc) {
			for (const table of LocalSymbol.getLocalsToRoot(doc.node)) {
				if (SymbolUtil.lookupTable(table, category, path).symbol) {
					return this.queryInTable(table, doc.doc, category, ...path)
				}
			}
			return GlobalSymbol.query(this, doc.doc, category, ...path)
		}
		return GlobalSymbol.query(this, doc, category, ...path)
	}

	/** Get all symbols visible in the current position
	 * Symbol from a nearer scope has higher precedence
	 * @param category the category of symbols to retrieve
	 * @param doc the local symbol context to start the search from
	 * @param path Optional. the path within the category to retrieve symbols from
	 */
	getScopedSymbols(
		category: string,
		doc: LocalSymbolContext,
		path: readonly string[] = [],
	): SymbolMap {
		const symbols = GlobalSymbol.query(this, doc.doc, category, ...path).visibleMembers
		for (const table of [...LocalSymbol.getLocalsToRoot(doc.node)].reverse()) {
			const result = SymbolUtil.lookupTable(table, category, path)
			Object.assign(symbols, path.length ? result.symbol?.members : table[category])
		}
		return symbols
	}

	/**
	 * Execute the given operation immediately or queue it
	 * depending on inDelayMode is on or off.
	 * @param operation the operation to execute
	 */
	runOrDefer(operation: () => void): void {
		if (!this._inDelayMode) {
			operation()
			return
		}
		this._delayedOps.push(() => {
			const delayed = this._inDelayMode
			this._inDelayMode = false
			try {
				operation()
			} finally {
				this._inDelayMode = delayed
			}
		})
	}

	/** Create a query against an explicitly selected table. */
	queryInTable(
		table: SymbolTable,
		doc: TextDocument | string,
		category: string,
		...path: string[]
	): SymbolQuery {
		const local = LocalSymbol.isTable(table)
		if (local) {
			LocalSymbol.registerMap(table[category] ??= {})
		}
		const lookup = (category: string, path: readonly string[]) =>
			SymbolUtil.lookupTable(table, category, path)
		const { parentSymbol, parentMap, symbol } = lookup(category, path)
		const visible = symbol ? SymbolUtil.isVisible(symbol, SymbolUtil.toUri(doc)) : true
		return new SymbolQuery({
			category,
			doc,
			contributor: this.#currentContributor,
			map: visible ? parentMap : undefined,
			parentSymbol,
			path,
			symbol: visible ? symbol : undefined,
			util: this,
			lookup,
			getRootMap: () =>
				local ? LocalSymbol.registerMap(table[category] ??= {}) : table[category] ??= {},
		})
	}

	static toUri(uri: TextDocument | string): string {
		if (typeof uri === 'string') {
			return uri
		}
		return uri.uri
	}

	/**
	 * Remove usages from a symbol based on a predicate.
	 *
	 * @param symbol The symbol to process
	 * @param predicate The predicate being checked
	 */
	removeLocationsFromSymbol(
		symbol: Symbol,
		predicate: (this: void, data: SymbolLocationEvent) => boolean,
	): void {
		this.runOrDefer(() => {
			for (const container of SymbolUtil.allUsageContainers(symbol)) {
				for (const type of SymbolUsageTypes) {
					const locations = container[type]
					const retained = locations?.filter(location => {
						if (!predicate({ location, symbol, type })) {
							return true
						}
						this.emit('symbolLocationRemoved', { symbol, type, location })
						return false
					})
					if (retained?.length !== locations?.length) {
						container[type] = retained
					}
				}
			}
		})
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
			if (addition.data || addition.usage) {
				this.amendSymbol(ans, addition, doc, contributor)
			}
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
			...(LocalSymbol.isMap(parentMap) || LocalSymbol.is(parentSymbol)
				? { isLocal: true as const }
				: {}),
			category,
			identifier,
			...(parentSymbol ? { parentSymbol } : {}),
			parentMap,
			path,
		})
		this.amendSymbolMetadata(ans, addition.data)
		this.emit('symbolCreated', { symbol: ans })
		if (addition.data || addition.usage) {
			this.amendSymbol(ans, addition, doc, contributor)
		}
		return ans
	}

	/**
	 * Amend the given symbol with the provided addition
	 * @param symbol The symbol to be amended.
	 * @param addition The addition containing new metadata and usage information.
	 * @param doc The document in which the amendment is taking place.
	 * @param contributor The contributor responsible for the amendment.
	 */
	amendSymbol(
		symbol: Symbol,
		addition: SymbolAddition,
		doc: TextDocument,
		contributor: string | undefined,
	): void {
		this.amendSymbolMetadata(symbol, addition.data)
		if (LocalSymbol.is(symbol)) {
			LocalSymbol.amendSymbol(this, symbol, addition, doc, contributor)
		} else {
			Isotope.amendSymbol(this, symbol, addition, doc, contributor)
		}
	}

	private amendSymbolMetadata(symbol: Symbol, addition: SymbolAddition['data']): void {
		if (!addition) {
			return
		}
		if ('data' in addition) {
			symbol.data = addition.data
		}
		if (addition.relations) {
			Object.assign(symbol.relations ??= {}, addition.relations)
		}
		if ('subcategory' in addition) {
			symbol.subcategory = addition.subcategory
		}
	}

	amendSymbolUsage(
		symbol: Symbol,
		addition: SymbolAddition['usage'],
		doc: TextDocument,
		contributor: string | undefined,
		owner: Partial<Record<SymbolUsageType, SymbolLocation[]>>,
	): void {
		if (addition) {
			const type = addition.type ?? 'reference'
			const arr = (owner[type] ??= [])
			const range = Range.get(
				(SymbolAdditionUsageWithNode.is(addition) ? addition.node : addition.range) ?? 0,
			)
			const location = SymbolLocation.create(doc, range, addition.fullRange, contributor, {
				isotopeIdentifier: addition.isotopeIdentifier,
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
		symbol = symbol ? Isotope.rawSymbol(symbol) : undefined
		return symbol?.relations?.aliasOf
			? this.resolveAlias(
				GlobalSymbol.lookup(
					this,
					symbol.relations.aliasOf.category,
					symbol.relations.aliasOf.path,
				).symbol,
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
		if (LocalSymbol.is(symbol)) {
			return LocalSymbol.isTrimmable(symbol)
		}
		return !Object.keys(symbol.members ?? {}).length && !Isotope.allIsotopes(symbol).length
			&& !Isotope.allUsageContainers(symbol).some(owner =>
				SymbolUsageTypes.some(type => owner[type]?.length)
			)
	}

	static allUsageContainers(symbol: Symbol): Partial<Record<SymbolUsageType, SymbolLocation[]>>[] {
		return LocalSymbol.is(symbol) ? [symbol] : Isotope.allUsageContainers(symbol)
	}
	/** @returns a view of the symbol from the context of the given URI. */
	static viewFromContext(
		symbol: Symbol | undefined,
		uri: string | undefined,
	): SymbolView | undefined {
		return LocalSymbol.is(symbol) ? symbol : Isotope.viewFromContext(symbol, uri)
	}
	static isVisible(symbol: Symbol, uri: string | undefined): boolean {
		return LocalSymbol.is(symbol) || Isotope.isVisible(symbol, uri)
	}
	static isFromFile(symbol: Symbol | undefined): boolean {
		return !!symbol
			&& SymbolUtil.allUsageContainers(symbol).some(owner =>
				owner.definition?.some(location => location.fromFile)
				|| owner.implementation?.some(location => location.fromFile)
			)
	}
	static hasNoAccessToFileSymbol(symbol: Symbol | undefined, uri: string): boolean {
		return !!symbol && !LocalSymbol.is(symbol) && Isotope.hasNoAccessToFileSymbol(symbol, uri)
	}

	private static locationsFor(
		symbol: DeepReadonly<Symbol> | undefined,
	): DeepReadonly<Partial<Record<SymbolUsageType, SymbolLocation[]>>> {
		if (!symbol) {
			return {}
		}
		if (LocalSymbol.is(symbol as Symbol)) {
			return symbol as SymbolView
		}
		if (Isotope.isContextualView(symbol as Symbol)) {
			return symbol as SymbolView
		}
		const raw = symbol as Symbol
		const isotope = Isotope.selectIsotope(raw, undefined)
		return isotope ? Isotope.ownerOf(raw, isotope) : {}
	}

	/**
	 * @returns If the symbol has declarations or definitions.
	 */
	static isDeclared(symbol: DeepReadonly<Symbol> | undefined): boolean {
		const view = SymbolUtil.locationsFor(symbol)
		return !!(view.declaration?.length || view.definition?.length)
	}
	/**
	 * @returns If the symbol has definitions, or declarations and implementations.
	 */
	static isDefined(symbol: DeepReadonly<Symbol> | undefined): symbol is Symbol {
		const view = SymbolUtil.locationsFor(symbol)
		return !!(view.definition?.length
			|| (view.declaration?.length && view.implementation?.length))
	}
	/**
	 * @returns If the symbol has implementations or definitions.
	 */
	static isImplemented(symbol: DeepReadonly<Symbol> | undefined): symbol is Symbol {
		const view = SymbolUtil.locationsFor(symbol)
		return !!(view.implementation?.length || view.definition?.length)
	}
	/**
	 * @returns If the symbol has references.
	 */
	static isReferenced(symbol: DeepReadonly<Symbol> | undefined): symbol is Symbol {
		return !!SymbolUtil.locationsFor(symbol).reference?.length
	}
	/**
	 * @returns If the symbol has type definitions.
	 */
	static isTypeDefined(symbol: DeepReadonly<Symbol> | undefined): symbol is Symbol {
		return !!SymbolUtil.locationsFor(symbol).typeDefinition?.length
	}

	/**
	 * @throws If the symbol does not have any declarations or definitions.
	 */
	static getDeclaredLocation(symbol: DeepReadonly<Symbol>): SymbolLocation {
		const view = this.locationsFor(symbol)
		return (view.declaration?.[0] ?? view.definition?.[0] ?? (() => {
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
		for (const owner of SymbolUtil.allUsageContainers(symbol)) {
			for (const type of SymbolUsageTypes) {
				owner[type]?.forEach((location) => fn({ type, location }))
			}
		}
	}
}

export interface SymbolAddition {
	data?: SymbolMetadata & {
		desc?: string
		scope?: IsotopeScope
		source?: SymbolIsotopeProvider
		overrideLevel?: number
	}
	usage?: SymbolAdditionUsage
}
export type SymbolAdditionUsage = SymbolAdditionUsageWithRange | SymbolAdditionUsageWithNode
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

type QueryCallback<S extends SymbolView | undefined = SymbolView | undefined> = (
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
	readonly #lookup: (category: string, path: readonly string[]) => LookupResult
	readonly #getRootMap: () => SymbolMap
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

	get symbol(): SymbolView | undefined {
		return SymbolUtil.viewFromContext(this.#symbol, this.#doc.uri)
	}

	get visibleMembers(): SymbolMap {
		return SymbolUtil.filterVisibleSymbols(
			this.#doc.uri,
			this.path.length === 0 ? this.#map : this.#symbol?.members,
		)
	}

	constructor(
		{ category, contributor, doc, map, parentSymbol, path, symbol, util, lookup, getRootMap }: {
			category: string
			contributor: string | undefined
			doc: TextDocument | string
			map: SymbolMap | undefined
			parentSymbol: Symbol | undefined
			path: readonly string[]
			symbol: Symbol | undefined
			util: SymbolUtil
			lookup: (category: string, path: readonly string[]) => LookupResult
			getRootMap: () => SymbolMap
		},
	) {
		this.category = category
		this.path = path

		if (typeof doc === 'string') {
			doc = TextDocument.create(doc, '', 0, '')
			this.#createdWithUri = true
		}
		this.#doc = doc
		this.#currentContributor = contributor
		this.#map = map
		this.#parentSymbol = parentSymbol
		this.#symbol = symbol
		this.util = util
		this.#lookup = lookup
		this.#getRootMap = getRootMap
	}

	heyGimmeDaSymbol() {
		return this.#symbol
	}

	getData<T>(predicate: (this: void, value: unknown) => value is T): T | undefined {
		const data = this.symbol?.data
		return predicate(data) ? data : undefined
	}

	with(fn: QueryMemberCallback): this {
		fn(this)
		return this
	}

	if(
		predicate: (this: void, symbol: SymbolView | undefined) => symbol is undefined,
		fn: QueryCallback<undefined>,
	): this
	if(
		predicate: (this: void, symbol: SymbolView | undefined) => symbol is SymbolView,
		fn: QueryCallback<SymbolView>,
	): this
	if(predicate: QueryCallback, fn: QueryCallback): this
	if(predicate: QueryCallback, fn: QueryCallback<any>): this {
		if (predicate.call(this, this.symbol, this)) {
			fn.call(this, this.symbol, this)
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
	ifKnown(fn: QueryCallback<SymbolView>): this {
		return this.if((s) => s !== undefined, fn as QueryCallback)
	}

	/**
	 * Calls `fn` if the queried symbol has declarations or definitions.
	 */
	ifDeclared(fn: QueryCallback<SymbolView>): this {
		return this.if((s): s is SymbolView => SymbolUtil.isDeclared(s), fn)
	}

	/**
	 * Calls `fn` if the queried symbol has definitions, or both declarations and implementations.
	 */
	ifDefined(fn: QueryCallback<SymbolView>): this {
		return this.if(SymbolUtil.isDefined, fn)
	}

	/**
	 * Calls `fn` if the queried symbol has implementations or definitions.
	 */
	ifImplemented(fn: QueryCallback<SymbolView>): this {
		return this.if(SymbolUtil.isImplemented, fn)
	}

	/**
	 * Calls `fn` if the queried symbol has references.
	 */
	ifReferenced(fn: QueryCallback<SymbolView>): this {
		return this.if(SymbolUtil.isReferenced, fn)
	}

	/**
	 * Calls `fn` if the queried symbol has type definitions.
	 */
	ifTypeDefined(fn: QueryCallback<SymbolView>): this {
		return this.if(SymbolUtil.isTypeDefined, fn)
	}

	/**
	 * Calls `fn` if none of the former `if` conditions are met.
	 */
	else(fn: QueryCallback): this {
		if (!this.#hasTriggeredIf) {
			fn.call(this, this.symbol, this)
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
		const getMap = (): SymbolMap => {
			if (this.#map) {
				return this.#map
			}
			if (this.path.length > 1) {
				if (this.#parentSymbol) {
					return this.#parentSymbol.members ??= {}
				}
			} else {
				return this.#getRootMap()
			}
			throw new Error('Cannot create the symbol map for “' + this.getPath() + '”')
		}

		// Treat `usage.range` as `[0, 0)` if this class was constructed with a string URI (instead of a `TextDocument`).
		if (this.#createdWithUri && SymbolAdditionUsageWithRange.is(addition.usage)) {
			addition.usage.range = Range.create(0, 0)
		}

		this.#map = getMap()
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
		const raw = this.#lookup(this.category, this.path).symbol
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
		this.enterImmediately({ ...addition, usage })
		if (!LocalSymbol.is(this.#symbol)) {
			Isotope.reconcileDocUsages(this.util, this.#symbol!)
		}
	}

	enterCommand(addition: SymbolAddition): this {
		this._enterCommand(addition)
		return this
	}

	@DelayModeSupport((self: SymbolQuery) => self.util)
	private _enterCommand(addition: SymbolAddition): void {
		const raw = this.#lookup(this.category, this.path).symbol
		if (LocalSymbol.is(raw) || LocalSymbol.isMap(this.#map)) {
			const originalType = addition.usage?.type ?? 'reference'
			this.enterImmediately({
				...addition,
				usage: {
					...addition.usage,
					originalUsageType: originalType,
					type: originalType === 'definition' && LocalSymbol.is(raw)
							&& raw.declaration?.some(value => value.fromDocDeclaration)
						? 'implementation'
						: originalType,
				},
			})
			return
		}
		const usage = Isotope.enterCommand(
			this.util,
			raw,
			addition,
			this.#doc,
			this.#currentContributor,
		)
		if (usage) {
			this.enterImmediately({ ...addition, usage })
		} else if (raw) {
			this.#symbol = raw
			this.#map = raw.parentMap
		}
	}

	migrateDefinitions(_identifier: string): this {
		this._reconcileUsages()
		return this
	}

	@DelayModeSupport((self: SymbolQuery) => self.util)
	private _reconcileUsages(): void {
		const symbol = this.#lookup(this.category, this.path).symbol
		if (symbol && !LocalSymbol.is(symbol)) {
			Isotope.reconcileDocUsages(this.util, symbol)
		}
	}

	enterIsotope(identifier: string, addition: SymbolIsotopeAddition): this {
		this._enterIsotope(identifier, addition)
		return this
	}

	@DelayModeSupport((self: SymbolQuery) => self.util)
	private _enterIsotope(identifier: string, addition: SymbolIsotopeAddition): void {
		if (
			LocalSymbol.isMap(this.#map) || LocalSymbol.is(this.#symbol)
			|| LocalSymbol.is(this.#parentSymbol)
		) {
			throw new Error('Local symbols do not support isotopes.')
		}
		const current = this.#lookup(this.category, this.path)
		this.#symbol = current.symbol
		if (current.symbol) {
			this.#map = current.symbol.parentMap
		}

		if (!this.#symbol) {
			if (addition.data?.scope === undefined) {
				throw new Error('Creating an isotope requires a scope.')
			}
			this.#map ??= this.path.length > 1
				? this.#parentSymbol ? this.#parentSymbol.members ??= {} : undefined
				: this.#getRootMap()
			if (!this.#map) {
				throw new Error('Cannot create isotope without parent symbol.')
			}
			this.#symbol = this.util.createSymbol(
				this.category,
				this.#parentSymbol,
				this.#map,
				this.path,
				this.path[this.path.length - 1],
				{},
				this.#doc,
				this.#currentContributor,
			)
		}
		if (this.#createdWithUri && SymbolAdditionUsageWithRange.is(addition.usage)) {
			addition.usage.range = Range.create(0, 0)
		}
		Isotope.writeIsotope(
			this.util,
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
			lookup: this.#lookup,
			getRootMap: this.#getRootMap,
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
				+ ` {${symbol.category}${symbol.subcategory ? ` (${symbol.subcategory})` : ''}}`,
		)
		if (symbol.data) {
			ans.push(`${IndentChar}data: ${JSON.stringify(symbol.data, bigintJsonNumberReplacer)}`)
		}
		if (symbol.facets) {
			ans.push(`${IndentChar}facets: ${JSON.stringify(symbol.facets, bigintJsonNumberReplacer)}`)
		}
		if (LocalSymbol.is(symbol)) {
			if (symbol.desc !== undefined) {
				ans.push(`${IndentChar}desc: ${JSON.stringify(symbol.desc)}`)
			}
			for (const type of SymbolUsageTypes) {
				if (symbol[type]?.length) {
					ans.push(
						`${IndentChar}${type}: ${JSON.stringify(symbol[type], bigintJsonNumberReplacer)}`,
					)
				}
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
