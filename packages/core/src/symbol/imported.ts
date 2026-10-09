import { TextDocument } from 'vscode-languageserver-textdocument'
import type { SymbolService } from './Service.js'
import type { Symbol, SymbolGlobalData, SymbolIsotope, SymbolMap, SymbolTable } from './Symbol.js'
import { SymbolIsotopeProvider, SymbolIsotopeScope, SymbolUsageTypes } from './Symbol.js'
import { SymbolUtil } from './util.js'
import { Isotope } from './util/isotope.js'

export namespace SymbolImport {
	/** Find consumer usages of the selected exported dependency isotope. */
	export function getImportedUsageContainer(
		service: SymbolService,
		symbol: Symbol,
		uri: string,
	): SymbolGlobalData | SymbolIsotope | undefined {
		if (symbol.isLocal || service.storage.owns(symbol)) {
			return undefined
		}
		const source = Isotope.selectIsotope(symbol, uri, service.storage.resolveResourceLocation)
		if (!source?.origin) {
			return undefined
		}
		const scope = Isotope.scopeOf(symbol, source)
		if (scope !== SymbolIsotopeScope.Global && scope !== SymbolIsotopeScope.Protected) {
			return undefined
		}
		const imported = service.lookup(symbol.category, symbol.path).symbol
		if (!imported || imported === symbol) {
			return undefined
		}
		const isotope = Isotope.allIsotopesOf(imported).find(candidate =>
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

	/** Merge filtered imports, keeping their metadata identities and shared usages. */
	export function importDependencySymbols(service: SymbolService, table: SymbolTable): void {
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
					service.storage.emit('symbolCreated', { symbol })
				}
				for (const isotope of entry.facets?.global?.isotopes ?? []) {
					Isotope.writeIsotope(
						service,
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
							service.storage.emit('symbolLocationRemoved', { symbol, type, location })
							return false
						})
						for (const location of entry.facets.global[type] ?? []) {
							;(facet[type] ??= []).push(location)
							service.storage.emit('symbolLocationCreated', { symbol, type, location })
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
								service.storage.emit('symbolLocationRemoved', { symbol, type, location })
							}
						}
						facets.isotopes![index] = isotope
					} else {
						;(facets.isotopes ??= []).push(isotope)
					}
					for (const type of SymbolUsageTypes) {
						for (const location of isotope[type] ?? []) {
							service.storage.emit('symbolLocationCreated', { symbol, type, location })
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
				merge(map, service.storage.global[category] ??= {})
			}
		}
	}

	export function removeDependencySymbols(
		service: SymbolService,
		checksum: string,
		shouldTrim = true,
	): void {
		SymbolUtil.forEachSymbol(service.storage.global, symbol => {
			const removed = new Set(
				Isotope.allIsotopesOf(symbol).filter(isotope =>
					isotope.source === SymbolIsotopeProvider.Imported
					&& isotope.providerName === checksum
				).map(isotope => isotope.identifier),
			)
			if (!removed.size) {
				if (SymbolUtil.isTrimmable(symbol)) {
					service.storage.markForTrim(symbol)
				}
				return
			}
			for (const owner of Isotope.allUsageContainers(symbol)) {
				for (const type of SymbolUsageTypes) {
					owner[type] = owner[type]?.filter(location => {
						if (
							!removed.has(location.isotopeIdentifier ?? '')
							&& !('identifier' in owner && removed.has(owner.identifier))
						) {
							return true
						}
						service.storage.emit('symbolLocationRemoved', { symbol, type, location })
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
			service.storage.markForTrim(symbol)
		})
		if (shouldTrim) {
			service.trim()
		}
	}
}
