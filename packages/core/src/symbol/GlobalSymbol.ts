import { TextDocument } from 'vscode-languageserver-textdocument'
import { Isotope } from './isotope.js'
import type { Symbol, SymbolGlobalData, SymbolIsotope, SymbolMap, SymbolTable } from './Symbol.js'
import {
	SymbolIsotopeProvider,
	SymbolIsotopeScope,
	SymbolPath,
	SymbolUsageTypes,
} from './Symbol.js'
import type { LookupResult, SymbolClearOptions, SymbolQuery } from './SymbolUtil.js'
import { SymbolUtil } from './SymbolUtil.js'

type UriSymbolCache = Record<string, Set<string>>
interface GlobalState {
	trimmableSymbols: Set<string>
	cache: { [contributor: string]: UriSymbolCache }
}
const states = new WeakMap<SymbolUtil, GlobalState>()

/** Operations specific to the global symbol table. */
export namespace GlobalSymbol {
	export function initialize(util: SymbolUtil): void {
		const state: GlobalState = { trimmableSymbols: new Set(), cache: Object.create(null) }
		states.set(util, state)

		util.on('symbolCreated', ({ symbol }) => {
			if (!ownsSymbol(util, symbol)) {
				return
			}
			state.trimmableSymbols.add(SymbolPath.toString(symbol))
		}).on('symbolRemoved', ({ symbol }) => {
			if (!ownsSymbol(util, symbol)) {
				return
			}
			state.trimmableSymbols.delete(SymbolPath.toString(symbol))
		}).on('symbolLocationCreated', ({ symbol, location }) => {
			if (!ownsSymbol(util, symbol)) {
				return
			}
			const cache =
				(state.cache[location.contributor ?? 'undefined'] ??= Object.create(null) as never)
			const fileSymbols = (cache[location.uri] ??= new Set())
			const path = SymbolPath.toString(symbol)
			fileSymbols.add(path)
			state.trimmableSymbols.delete(path)
		}).on('symbolLocationRemoved', ({ symbol }) => {
			if (!ownsSymbol(util, symbol)) {
				return
			}
			const path = SymbolPath.toString(symbol)
			state.trimmableSymbols.add(path)
		})
	}
	export function query(
		util: SymbolUtil,
		doc: TextDocument | string,
		category: string,
		...path: string[]
	): SymbolQuery {
		return util.queryInTable(util.global, doc, category, ...path)
	}

	/** Find consumer usages of the selected exported dependency isotope. */
	export function getImportedUsageContainer(
		util: SymbolUtil,
		symbol: Symbol,
		uri: string,
	): SymbolGlobalData | SymbolIsotope | undefined {
		if (symbol.isLocal || ownsSymbol(util, symbol)) {
			return undefined
		}
		const source = Isotope.selectIsotope(symbol, uri)
		if (!source?.origin) {
			return undefined
		}
		const scope = Isotope.scopeOf(symbol, source)
		if (scope !== SymbolIsotopeScope.Global && scope !== SymbolIsotopeScope.Namespace) {
			return undefined
		}
		const imported = lookup(util, symbol.category, symbol.path).symbol
		if (!imported || imported === symbol) {
			return undefined
		}
		const isotope = Isotope.allIsotopes(imported).find(candidate =>
			candidate.source === SymbolIsotopeProvider.Imported
			&& candidate.providerName !== undefined
			&& candidate.origin?.uri === source.origin?.uri
			&& candidate.origin?.contributor === source.origin?.contributor
			&& Isotope.scopeOf(imported, candidate) === scope
			&& candidate.identifier
				=== JSON.stringify([candidate.providerName, 'isotope', source.identifier])
		)
		return isotope && Isotope.ownerOf(imported, isotope)
	}

	/**
	 * Build the internal cache of the SymbolUtil according to the current global symbol table.
	 */
	export function buildCache(util: SymbolUtil): void {
		SymbolUtil.forEachSymbol(util.global, (symbol) => {
			util.emit('symbolCreated', { symbol })
			SymbolUtil.forEachLocationOfSymbol(symbol, ({ type, location }) => {
				util.emit('symbolLocationCreated', { symbol, type, location })
			})
		})
	}

	/**
	 * @param
	 * 	- `contributor` - clear symbol locations contributed by this contributor. Pass in `undefined`
	 * 	to select all symbol locations that don't have a contributor.
	 * 	- `uri` - clear symbol locations associated with this URI.
	 * 	- `predicate` - clear symbol locations matching this predicate
	 */
	export function clear(
		util: SymbolUtil,
		{ uri, contributor, predicate = () => true }: SymbolClearOptions,
	): void {
		util.runOrDefer(() => {
			const state = states.get(util)!
			const getCaches = (): UriSymbolCache[] => {
				if (contributor) {
					return state.cache[contributor] ? [state.cache[contributor]] : []
				} else {
					return Object.values(state.cache)
				}
			}
			const getPaths = (): SymbolPath[] => {
				const caches = getCaches()
				const sets: Set<string>[] = uri
					? caches.map((cache) => cache[uri] ?? new Set())
					: caches.map((cache) => Object.values(cache)).flat()
				return sets.map((s) => [...s]).flat().map(SymbolPath.fromString)
			}
			const paths = getPaths()
			for (const path of paths) {
				const { symbol } = lookup(util, path.category, path.path)
				if (!symbol) {
					continue
				}
				const removedIds = new Set<string>()
				let removed = false
				let removedDocDeclaration = false
				util.removeLocationsFromSymbol(
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
					Isotope.cleanupAfterLocationRemoval(util, symbol, removedIds, removedDocDeclaration)
				}
			}
			trim(util)
		})
	}

	/** Look up a symbol in the global table. */
	export function lookup(
		util: SymbolUtil,
		category: string,
		path: readonly string[],
	): LookupResult {
		return SymbolUtil.lookupTable(util.global, category, path)
	}

	export function getVisibleSymbols(util: SymbolUtil, category: string, uri?: string): SymbolMap {
		const map = lookup(util, category, []).parentMap ?? undefined

		return SymbolUtil.filterVisibleSymbols(uri, map)
	}

	export function getSymbolsInFile(util: SymbolUtil, uri: string): Symbol[] {
		const paths = new Set<string>()
		for (const cache of Object.values(states.get(util)!.cache)) {
			for (const path of cache[uri] ?? []) {
				paths.add(path)
			}
		}
		const symbols: Symbol[] = []
		for (const key of paths) {
			const path = SymbolPath.fromString(key)
			const symbol = lookup(util, path.category, path.path).symbol
			if (symbol) {
				symbols.push(symbol)
			}
		}
		return symbols
	}

	/** Remove unused global symbols recorded by the global cache. */
	export function trim(util: SymbolUtil): void {
		util.runOrDefer(() => {
			const state = states.get(util)!
			const trimSymbol = (symbol: Symbol | undefined) => {
				if (!symbol) {
					return
				}
				if (SymbolUtil.isTrimmable(symbol)) {
					delete symbol.parentMap[symbol.identifier]
					util.emit('symbolRemoved', { symbol })
					trimSymbol(symbol.parentSymbol)
				}
			}
			for (const pathString of state.trimmableSymbols) {
				state.trimmableSymbols.delete(pathString)
				const path = SymbolPath.fromString(pathString)
				const { symbol } = lookup(util, path.category, path.path)
				trimSymbol(symbol)
			}
		})
	}

	/** Merge filtered imports, keeping their metadata identities and shared usages. */
	export function importDependencySymbols(util: SymbolUtil, table: SymbolTable): void {
		const merge = (source: SymbolMap, target: SymbolMap, parent?: Symbol): void => {
			for (const entry of Object.values(source)) {
				let symbol = target[entry.identifier]
				if (!symbol) {
					symbol = target[entry.identifier] = {
						category: entry.category,
						identifier: entry.identifier,
						path: entry.path,
						parentMap: target,
						parentSymbol: parent,
						subcategory: entry.subcategory,
					}
					util.emit('symbolCreated', { symbol })
				}
				for (const isotope of entry.facets?.global?.isotopes ?? []) {
					Isotope.writeIsotope(
						util,
						symbol,
						isotope.identifier,
						{ data: { ...isotope, scope: SymbolIsotopeScope.Global } },
						TextDocument.create('', '', 0, ''),
						undefined,
					)
				}
				if (entry.facets?.global) {
					const facet = symbol.facets!.global!
					const ids = new Set(entry.facets.global.isotopes.map(isotope => isotope.identifier))
					for (const type of SymbolUsageTypes) {
						facet[type] = facet[type]?.filter(location => {
							if (!location.isotopeIdentifier || !ids.has(location.isotopeIdentifier)) {
								return true
							}
							util.emit('symbolLocationRemoved', { symbol, type, location })
							return false
						})
						for (const location of entry.facets.global[type] ?? []) {
							;(facet[type] ??= []).push(location)
							util.emit('symbolLocationCreated', { symbol, type, location })
						}
					}
				}
				for (const isotope of entry.facets?.isotopes ?? []) {
					const facets = symbol.facets ??= {}
					const index = facets.isotopes?.findIndex(value =>
						value.identifier === isotope.identifier
					) ?? -1
					if (index >= 0) {
						for (const type of SymbolUsageTypes) {
							for (const location of facets.isotopes![index][type] ?? []) {
								util.emit('symbolLocationRemoved', { symbol, type, location })
							}
						}
						facets.isotopes![index] = isotope
					} else {
						;(facets.isotopes ??= []).push(isotope)
					}
					for (const type of SymbolUsageTypes) {
						for (const location of isotope[type] ?? []) {
							util.emit('symbolLocationCreated', { symbol, type, location })
						}
					}
				}
				if (entry.members) {
					merge(entry.members, symbol.members ??= {}, symbol)
				}
			}
		}
		for (const [category, map] of Object.entries(table)) {
			if (map && category !== 'mcdoc' && category !== 'mcdoc/dispatcher') {
				merge(map, util.global[category] ??= {})
			}
		}
	}

	export function removeDependencySymbols(
		util: SymbolUtil,
		checksum: string,
		shouldTrim = true,
	): void {
		const state = states.get(util)!
		SymbolUtil.forEachSymbol(util.global, symbol => {
			const removed = new Set(
				Isotope.allIsotopes(symbol).filter(isotope =>
					isotope.source === SymbolIsotopeProvider.Imported
					&& isotope.providerName === checksum
				).map(isotope => isotope.identifier),
			)
			for (const owner of Isotope.allUsageContainers(symbol)) {
				for (const type of SymbolUsageTypes) {
					owner[type] = owner[type]?.filter(location => {
						if (
							!removed.has(location.isotopeIdentifier ?? '')
							&& !('identifier' in owner && removed.has(owner.identifier))
						) {
							return true
						}
						util.emit('symbolLocationRemoved', { symbol, type, location })
						return false
					})
				}
			}
			for (const facet of [symbol.facets?.global, symbol.facets?.internal]) {
				if (facet) {
					facet.isotopes = facet.isotopes.filter(isotope => !removed.has(isotope.identifier))
				}
			}
			if (symbol.facets?.isotopes) {
				symbol.facets.isotopes = symbol.facets.isotopes.filter(isotope =>
					!removed.has(isotope.identifier)
				)
			}
			if (SymbolUtil.isTrimmable(symbol)) {
				state.trimmableSymbols.add(SymbolPath.toString(symbol))
			}
		})
		if (shouldTrim) {
			trim(util)
		}
	}

	/**
	 * @returns the canonical data of a symbol, which is stored in its first global isotope.
	 */
	export function getCanonicalData(symbol: Pick<Symbol, 'facets'> | undefined): unknown {
		return symbol?.facets?.global?.isotopes[0]?.data
	}

	function ownsSymbol(util: SymbolUtil, symbol: Symbol): boolean {
		while (symbol.parentSymbol) {
			symbol = symbol.parentSymbol
		}
		return symbol.parentMap === util.global[symbol.category]
	}
}
