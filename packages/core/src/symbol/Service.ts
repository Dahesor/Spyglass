import type { TextDocument } from 'vscode-languageserver-textdocument'
import { Range } from '../source/index.js'
import {
	type SymbolAddition,
	type SymbolAdditionUsage,
	SymbolAdditionUsageWithNode,
	SymbolHandle,
} from './Handle.js'
import { LocalSymbol, type LocalSymbolContext } from './local.js'
import type { SymbolEvents, SymbolLocationEvent, SymbolStorage } from './Storage.js'
import type {
	AllCategory,
	Symbol,
	SymbolLocationBuiltInContributor,
	SymbolMap,
	SymbolTable,
	SymbolUsageType,
	SymbolView,
} from './Symbol.js'
import { SymbolLocation, SymbolPath, SymbolUsageTypes } from './Symbol.js'
import type { LookupResult } from './util.js'
import { SymbolUtil } from './util.js'
import { Isotope } from './util/isotope.js'

/** A resolved write destination. The caller should keep its fields consistent. */
export interface SymbolWriteTarget {
	parentSymbol?: Symbol
	/** The selected table's category map, or the parent symbol's members. */
	map: SymbolMap
	/** The category of the symbol. */
	category: AllCategory | (string & {})
	/** The full path within the category, ending with identifier. */
	path: readonly string[]
	/** The key in map.*/
	identifier: string
}

export interface SymbolClearOptions {
	contributor?: string
	uri?: string
	predicate?: (this: void, data: SymbolLocationEvent) => boolean
}

/** A light weighted service for managing symbol contribution and pending edits.
 * Holds a **reference** to a {@link SymbolStorage}, which has a {@link SymbolTable} inside.
 * Does not own the symbol table.
 */
export class SymbolService {
	#currentContributor: string | undefined
	#isDelayModeOn: boolean | undefined

	/** A list of pending operations.
	 * Operations in here are only applied when {@link applyDelayedEdits} is called.
	 */
	#pendingEdits: (() => void)[]

	constructor(readonly storage: SymbolStorage) {
		this.#pendingEdits = []
	}

	/**
	 * Clone a SymbolService referencing the same {@link SymbolStorage}.
	 * The clone will not copy the pending edits from the original.
	 * Creating a clone is expected to be cheap and is constant-time.
	 * @returns A clone of this SymbolService
	 */
	clone(): SymbolService {
		const clone = new SymbolService(this.storage)
		clone.#currentContributor = this.#currentContributor
		clone.#isDelayModeOn = this.#isDelayModeOn
		return clone
	}

	/**
	 * Clone a SymbolService referencing the same {@link SymbolStorage}.
	 * Creating a clone is expected to be cheap and is constant-time.
	 * @returns A clone of this SymbolService that is in delay mode.
	 * In delay mode, operations applied through {@link runOrDefer} will
	 * not take effect until the {@link SymbolService.applyDelayedEdits} method is called on the clone.
	 * The clone owns its pending edits.
	 */
	cloneDelayed(): SymbolService {
		return this.clone().setDelayMode(true)
	}

	/**
	 * Execute the given operation immediately or queue it
	 * depending on whether delay mode is on.
	 * @param operation the operation to execute
	 */
	runOrDefer(operation: () => void): void {
		if (this.#isDelayModeOn) {
			this.#pendingEdits.push(operation)
		} else {
			operation()
		}
	}

	/**
	 * Apply edits done during the delay mode.
	 */
	applyDelayedEdits(): void {
		const edits = this.#pendingEdits
		this.#pendingEdits = []
		const originalDelayMode = this.#isDelayModeOn
		this.#isDelayModeOn = false
		try {
			for (const edit of edits) {
				edit()
			}
		} finally {
			this.#isDelayModeOn = originalDelayMode
		}
	}

	/** Set the delay mode.
	 * @param new_mode Whether to enable delay mode.
	 */
	setDelayMode(new_mode: boolean): SymbolService {
		this.#isDelayModeOn = new_mode
		return this
	}

	/**
	 * All symbol locations added in `fn` will be contributed as `contributor`.
	 *
	 * @param contributor The name of the contributor. See {@link SymbolLocation.contributor}
	 * @param fn The operation
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
	 * An asynchronous version of {@link contributeAs}.
	 * Should use separate service instances for overlapping callbacks .
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
	 * @returns a {@link SymbolHandle} object.
	 * @param doc A {@link TextDocument}, a {@link LocalSymbolContext}, or a string URI.
	 * It is used to both check the visibility of symbols and serve as the location of future entered symbol usages.
	 * If a URI is provided, it will use `[0, 0)` as `node.range`.
	 */
	query(
		doc: LocalSymbolContext | TextDocument | string,
		category: AllCategory,
		...path: string[]
	): SymbolHandle
	query(
		doc: LocalSymbolContext | TextDocument | string,
		category: string,
		...path: string[]
	): SymbolHandle
	query(
		doc: LocalSymbolContext | TextDocument | string,
		category: string,
		...path: string[]
	): SymbolHandle {
		if (typeof doc !== 'string' && 'doc' in doc) {
			// Search local tables first and go up to the root, then global table.
			for (const table of LocalSymbol.getLocalsToRoot(doc.node)) {
				if (SymbolUtil.lookupInTable(table, category, path).symbol) {
					return this.queryInTable(table, doc.doc, category, ...path)
				}
			}
			return this.queryInTable(this.storage.global, doc.doc, category, ...path)
		}
		return this.queryInTable(this.storage.global, doc, category, ...path)
	}

	/** @returns a {@link SymbolHandle} object against an explicitly selected table. */
	queryInTable(
		table: SymbolTable,
		doc: TextDocument | string,
		category: string,
		...path: string[]
	): SymbolHandle {
		const local = LocalSymbol.isTable(table)
		if (local) {
			LocalSymbol.registerMap(table[category] ??= {})
		}
		const lookup = (category: string, path: readonly string[]) =>
			SymbolUtil.lookupInTable(table, category, path)
		const { parentSymbol, parentMap, symbol } = lookup(category, path)
		const visible = symbol
			? this.isVisible(symbol, SymbolUtil.toUri(doc))
			: true
		return new SymbolHandle({
			category,
			doc,
			contributor: this.#currentContributor,
			map: visible ? parentMap : undefined,
			parentSymbol,
			path,
			symbol: visible ? symbol : undefined,
			service: this,
			lookup,
			getRootMap: () =>
				local ? LocalSymbol.registerMap(table[category] ??= {}) : table[category] ??= {},
		})
	}

	/** Look up a symbol in the storage. */
	lookup(
		category: string,
		path: readonly string[],
	): LookupResult {
		return SymbolUtil.lookupInTable(this.storage.global, category, path)
	}

	/**
	 * @param contributor clear symbol locations contributed by this contributor. Omit to select all contributors.
	 * @param uri clear symbol locations associated with this URI.
	 * @param predicate clear symbol locations matching this predicate
	 */
	clear(
		{ uri, contributor, predicate = () => true }: SymbolClearOptions,
	): void {
		this.runOrDefer(() => {
			const paths = this.storage.getPaths(uri || undefined, contributor)
			for (const key of paths) {
				const path = SymbolPath.fromString(key)
				const { symbol } = this.lookup(path.category, path.path)
				if (!symbol) {
					continue
				}
				const removedIds = new Set<string>()
				let removed = false
				let removedDocDeclaration = false
				this.removeLocationsFromSymbol(
					symbol,
					(data) => {
						const remove = (!uri || data.location.uri === uri)
							&& (!contributor || data.location.contributor === contributor)
							&& predicate(data)
						if (remove && data.location.isotopeIdentifier) {
							removedIds.add(data.location.isotopeIdentifier)
						}
						removed ||= remove
						removedDocDeclaration ||= remove && !!data.location.fromDocDeclaration
						return remove
					},
				)
				if (removed) {
					Isotope.cleanupAfterLocationRemoval(
						this,
						symbol,
						removedIds,
						removedDocDeclaration,
					)
				}
			}
			this.trim()
		})
	}

	/** Get all symbols visible in the current position
	 * Symbol from a nearer scope has higher precedence
	 * @param category the category of symbols to retrieve
	 * @param doc the local symbol context to start the search from
	 * @param path *Optional*. the path within the category to retrieve symbols from
	 */
	getScopedSymbols(
		category: string,
		doc: LocalSymbolContext,
		path: readonly string[] = [],
	): SymbolMap {
		const symbols =
			this.queryInTable(this.storage.global, doc.doc, category, ...path).visibleMembers
		for (const table of [...LocalSymbol.getLocalsToRoot(doc.node)].reverse()) {
			const result = SymbolUtil.lookupInTable(table, category, path)
			Object.assign(symbols, path.length ? result.symbol?.members : table[category])
		}
		return symbols
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
						this.storage.emit('symbolLocationRemoved', { symbol, type, location })
						return false
					})
					if (retained?.length !== locations?.length) {
						container[type] = retained
					}
				}
			}
		})
	}

	/** @returns The symbols visible from the uri. */
	getVisibleSymbols(
		category: string,
		uri?: string,
	): SymbolMap {
		const map = this.lookup(category, []).parentMap ?? undefined
		return this.filterVisibleSymbolsInMap(uri, map)
	}

	/**
	 * Get existing global symbols whose paths are indexed for the given URI,
	 * @param uri The URI to look up for.
	 * @returns A new array of raw symbols, deduplicated by path.
	 */
	getSymbolsInFile(uri: string): Symbol[] {
		const paths = this.storage.getPaths(uri)
		const symbols: Symbol[] = []
		for (const key of paths) {
			const path = SymbolPath.fromString(key)
			const symbol = this.lookup(path.category, path.path).symbol
			if (symbol) {
				symbols.push(symbol)
			}
		}
		return symbols
	}

	/**
	 * Enters a symbol into a symbol map. If there is already a symbol with the specified identifier under the map,
	 * it will be amended with the information provided in `addition`. Otherwise, a new symbol with that identifier
	 * will be created.
	 *
	 * @param target The resolved destination. No scope lookup is performed here.
	 * @param addition The metadata and usage to add to the existing or newly created symbol.
	 * @param doc The document used for contributed symbol usages.
	 * @param contributor The contributor responsible for the addition, if specified.
	 * @returns The created or amended symbol.
	 */
	enterMap(
		target: SymbolWriteTarget,
		addition: SymbolAddition,
		doc: TextDocument,
		contributor: string | undefined,
	): Symbol {
		const { map, identifier } = target
		let ans = map[identifier]
		if (ans) {
			if (addition.data || addition.usage) {
				this.amendSymbol(ans, addition, doc, contributor)
			}
		} else {
			ans = this.createSymbol(target, addition, doc, contributor)
		}
		this.storage.emit('symbolAmended', { symbol: ans })
		return ans
	}

	/**
	 * Creates and inserts a symbol at the resolved destination.
	 * The caller must ensure that the destination does not already contain the symbol.
	 * @param target The resolved destination. The new symbol's parentMap references `target.map`.
	 * @param addition The initial metadata and usage information.
	 * @param doc The document used for contributed symbol usages.
	 * @param contributor The contributor responsible for the addition, if specified.
	 * @returns The created symbol.
	 */
	createSymbol(
		target: SymbolWriteTarget,
		addition: SymbolAddition,
		doc: TextDocument,
		contributor: string | undefined,
	): Symbol {
		const { category, parentSymbol, map: parentMap, path, identifier } = target
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
		this.storage.emit('symbolCreated', { symbol: ans })
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

	/**
	 * Creates a symbol location from the supplied usage, appends it to the owner,
	 * and emits a `symbolLocationCreated` event.
	 *
	 * Does nothing if `addition` is undefined. The usage type defaults to `reference`.
	 * For non-file URIs, the location is stored without range information.
	 *
	 * @param symbol The symbol associated with the location and emitted event.
	 * @param addition The usage to record, including its node or range and metadata.
	 * @param doc The document used to create the location.
	 * @param contributor The contributor responsible for the usage, if specified.
	 * @param container The container whose usage arrays receive the location.
	 */
	appendSymbolUsage(
		symbol: Symbol,
		addition: SymbolAdditionUsage | undefined,
		doc: TextDocument,
		contributor: string | undefined,
		container: Partial<Record<SymbolUsageType, SymbolLocation[]>>,
	): void {
		if (addition) {
			const type = addition.type ?? 'reference'
			const arr = (container[type] ??= [])
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
			this.storage.emit('symbolLocationCreated', { symbol, type, location })
		}
	}

	/**
	 * @returns The ultimate symbol being pointed by the passed-in `symbol`'s alias.
	 */
	resolveAlias(symbol: Symbol | undefined): Symbol | undefined {
		symbol = symbol ? Isotope.rawSymbol(symbol) : undefined
		return symbol?.relations?.aliasOf
			? this.resolveAlias(
				SymbolUtil.lookupInTable(
					this.storage.global,
					symbol.relations.aliasOf.category,
					symbol.relations.aliasOf.path,
				).symbol,
			)
			: symbol
	}

	/** Remove unused global symbols recorded by the global cache. */
	trim(): void {
		this.runOrDefer(() => this.storage.trim())
	}

	/** @returns A {@link SymbolMap} that contains symbols visible from the given URI. */
	filterVisibleSymbolsInMap(uri: string | undefined, map: SymbolMap = {}): SymbolMap {
		const ans: SymbolMap = {}
		for (const identifier of Object.keys(map)) {
			const symbol = map[identifier]
			if (SymbolUtil.isVisible(symbol, uri, this.storage.resolveResourceLocation)) {
				ans[identifier] = symbol
			}
		}
		return ans
	}

	/** @returns A {@link SymbolView} from the given URI context. */
	viewFromContext(symbol: Symbol | undefined, uri: string | undefined): SymbolView | undefined {
		return SymbolUtil.viewFromContext(symbol, uri, this.storage.resolveResourceLocation)
	}

	/** @returns Whether the symbol is visible from the given URI. */
	isVisible(symbol: Symbol, uri: string | undefined): boolean {
		return SymbolUtil.isVisible(symbol, uri, this.storage.resolveResourceLocation)
	}

	/** @returns true if the symbol exits but the current URI has no access to it. */
	hasNoAccessToFileSymbol(symbol: Symbol | undefined, uri: string): boolean {
		return SymbolUtil.hasNoAccessToFileSymbol(symbol, uri, this.storage.resolveResourceLocation)
	}

	/** Emit a symbol event.*/
	emitEvent<K extends keyof SymbolEvents & string>(name: K, data: SymbolEvents[K]): void {
		// redirect it to its storage.
		// keep this function just for semantic clearance.
		this.storage.emit(name, data)
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
}
