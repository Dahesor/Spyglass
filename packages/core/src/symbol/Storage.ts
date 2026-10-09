import { EventDispatcher } from '../common/index.js'
import type { Symbol, SymbolLocation, SymbolTable, SymbolUsageType } from './Symbol.js'
import { SymbolPath } from './Symbol.js'
import { SymbolUtil } from './util.js'
import type { ResourceLocationResolver } from './util/visibility.js'

interface SymbolEvent {
	symbol: Symbol
}
export interface SymbolLocationEvent extends SymbolEvent {
	type: SymbolUsageType
	location: SymbolLocation
}
export type SymbolEvents = {
	symbolCreated: SymbolEvent
	symbolAmended: SymbolEvent
	symbolRemoved: SymbolEvent
	symbolLocationCreated: SymbolLocationEvent
	symbolLocationRemoved: SymbolLocationEvent
}

interface UriSymbolCache {
	uris: Record<string, Map<string, number>>
	size: number
}

/**
 * Owns a global table, its indexes and its committed-change events.
 */
export class SymbolStorage extends EventDispatcher<SymbolEvents> {
	readonly #trimCandidates = new Set<string>()
	readonly #cache = new Map<string | undefined, UriSymbolCache>()
	#hadObservers = false

	constructor(
		readonly global: SymbolTable = {},
		readonly resolveResourceLocation?: ResourceLocationResolver,
	) {
		super()
		this.rebuildIndex()
	}

	/** @returns true if this storage owns the given symbol. */
	owns(symbol: Symbol): boolean {
		while (symbol.parentSymbol) {
			symbol = symbol.parentSymbol
		}
		return symbol.parentMap === this.global[symbol.category]
	}

	/**
	 * Collect candidate symbol paths from the location index, optionally filtered by
	 * URI and contributor, without scanning the symbol table.
	 *
	 * @param uri The location URI to select. Omit to select all URIs.
	 * @param contributor The location contributor to select. Omit to select all contributors.
	 * @returns A new set of serialized {@link SymbolPath}.
	 * Entries are removed with their last location. Direct table edits require rebuildIndex().
	 */
	getPaths(uri?: string, contributor?: string): Set<string> {
		const selected = contributor ? this.#cache.get(contributor) : undefined
		const caches = contributor ? selected ? [selected] : [] : this.#cache.values()
		const paths = new Set<string>()
		for (const cache of caches) {
			for (const set of uri !== undefined ? [cache.uris[uri]] : Object.values(cache.uris)) {
				for (const path of set?.keys() ?? []) {
					paths.add(path)
				}
			}
		}
		return paths
	}

	/** Mark a symbol as a candidate for trimming. */
	markForTrim(symbol: Symbol): void {
		if (this.owns(symbol)) {
			this.#trimCandidates.add(SymbolPath.toString(symbol))
		}
	}

	/** Remove unused candidates in #trimCandidates */
	trim(): void {
		const trimSymbol = (symbol: Symbol | undefined): void => {
			if (symbol && SymbolUtil.isTrimmable(symbol)) {
				delete symbol.parentMap[symbol.identifier]
				this.emit('symbolRemoved', { symbol })
				trimSymbol(symbol.parentSymbol)
			}
		}
		for (const key of this.#trimCandidates) {
			this.#trimCandidates.delete(key)
			const path = SymbolPath.fromString(key)
			trimSymbol(SymbolUtil.lookupInTable(this.global, path.category, path.path).symbol)
		}
	}

	/** Keep indexes current before notifying observers */
	override emit<K extends keyof SymbolEvents & string>(name: K, data: SymbolEvents[K]): void {
		const { symbol } = data
		switch (name) {
			case 'symbolCreated':
				this.markForTrim(symbol)
				break
			case 'symbolLocationRemoved':
				if (this.owns(symbol)) {
					this.unindexLocation(symbol, (data as SymbolLocationEvent).location)
				}
				this.markForTrim(symbol)
				break
			case 'symbolRemoved':
				if (this.owns(symbol)) {
					this.#trimCandidates.delete(SymbolPath.toString(symbol))
				}
				break
			case 'symbolLocationCreated':
				if (this.owns(symbol)) {
					this.indexLocation(symbol, (data as SymbolLocationEvent).location)
				}
				break
		}
		if (this.#hadObservers) {
			super.emit(name, data)
		}
	}

	override on<K extends keyof SymbolEvents & string>(
		name: K,
		listener: (data: SymbolEvents[K]) => unknown,
		options?: AddEventListenerOptions,
	): this {
		// Enable dispatch only when an observer subscribes
		// Never disable it again to keep things simple, at least for now
		this.#hadObservers = true
		return super.on(name, listener, options)
	}

	private indexLocation(symbol: Symbol, location: SymbolLocation): void {
		let cache = this.#cache.get(location.contributor)
		if (!cache) {
			this.#cache.set(location.contributor, cache = { uris: Object.create(null), size: 0 })
		}
		let paths = cache.uris[location.uri]
		if (!paths) {
			cache.uris[location.uri] = paths = new Map()
			cache.size++
		}
		const path = SymbolPath.toString(symbol)
		paths.set(path, (paths.get(path) ?? 0) + 1)
		this.#trimCandidates.delete(path)
	}

	private unindexLocation(symbol: Symbol, location: SymbolLocation): void {
		const cache = this.#cache.get(location.contributor)
		const paths = cache?.uris[location.uri]
		const path = SymbolPath.toString(symbol)
		const count = paths?.get(path)
		if (count === undefined) {
			return
		}
		if (count > 1) {
			paths!.set(path, count - 1)
		} else {
			paths!.delete(path)
			if (!paths!.size) {
				delete cache!.uris[location.uri]
				cache!.size--
				if (!cache!.size) {
					this.#cache.delete(location.contributor)
				}
			}
		}
	}

	/** Reconstruct derived indexes */
	rebuildIndex(): void {
		this.#cache.clear()
		this.#trimCandidates.clear()
		SymbolUtil.forEachSymbol(this.global, symbol => {
			this.#trimCandidates.add(SymbolPath.toString(symbol))
			SymbolUtil.forEachLocationOfSymbol(symbol, ({ location }) => {
				this.indexLocation(symbol, location)
			})
		})
	}
}
