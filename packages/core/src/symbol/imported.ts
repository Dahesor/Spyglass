import { TextDocument } from 'vscode-languageserver-textdocument'
import type { SymbolService } from './Service.js'
import type { Symbol, SymbolMap, SymbolTable, SymbolUsages } from './Symbol.js'
import {
	SymbolGlobalScopeTypes,
	SymbolIsotopeProvider,
	SymbolIsotopeScope,
	SymbolRestrictedScopeTypes,
	SymbolScopeTypes,
	SymbolUsageTypes,
} from './Symbol.js'
import { SymbolUtil } from './util.js'
import { Isotope } from './util/isotope.js'

export namespace SymbolImport {
	export function replaceDependencyFile(
		service: SymbolService,
		previous: string,
		checksum: string,
		uri: string,
		exported: SymbolTable,
	): void {
		service.runOrDefer(() =>
			replaceDependencyFileImmediately(service, previous, checksum, uri, exported)
		)
	}

	function replaceDependencyFileImmediately(
		service: SymbolService,
		previous: string,
		checksum: string,
		uri: string,
		exported: SymbolTable,
	): void {
		const pendingUsages = new Map<Symbol, SymbolUsages>()
		for (const [category, map] of Object.entries(service.storage.global)) {
			if (!map || category === 'mcdoc' || category === 'mcdoc/dispatcher') {
				continue
			}
			SymbolUtil.forEachSymbolInMap(map, symbol => {
				const imported = Isotope.allIsotopesOf(symbol).filter(isotope =>
					isotope.source === SymbolIsotopeProvider.Imported
					&& isotope.providerName === previous
				)
				if (!imported.length) {
					return
				}
				const removed = new Set(imported.filter(isotope => isotope.origin?.uri === uri))
				const identifiers = new Map(imported.map(isotope => {
					const identity = JSON.parse(isotope.identifier) as [string, string, string]
					identity[0] = checksum
					return [isotope.identifier, JSON.stringify(identity)]
				}))
				for (const usages of Isotope.allDistinctUsages(symbol)) {
					for (const type of SymbolUsageTypes) {
						usages[type] = usages[type]?.filter(location => {
							if (location.uri === uri && location.importedFrom === previous) {
								service.storage.recordLocationRemoved(symbol, location)
								return false
							}
							if (location.importedFrom === previous) {
								location.importedFrom = checksum
							}
							if (
								location.isotopeIdentifier && identifiers.has(location.isotopeIdentifier)
							) {
								location.isotopeIdentifier = identifiers.get(location.isotopeIdentifier)
							}
							return true
						})
					}
				}
				const publicIsotopes = symbol.scopes?.public
				for (const key of SymbolGlobalScopeTypes) {
					const isotopes = symbol.scopes?.[key]
					if (isotopes) {
						symbol.scopes![key] = isotopes.filter(isotope => !removed.has(isotope))
					}
				}
				if (publicIsotopes?.length && !symbol.scopes?.public?.length) {
					pendingUsages.set(symbol, publicIsotopes[0].usages)
				}
				for (const key of SymbolRestrictedScopeTypes) {
					const isotopes = symbol.scopes?.[key]
					if (!isotopes) {
						continue
					}
					symbol.scopes![key] = isotopes.filter(isotope => {
						if (!removed.has(isotope)) {
							return true
						}
						for (const type of SymbolUsageTypes) {
							for (const location of isotope.usages[type] ?? []) {
								service.storage.recordLocationRemoved(symbol, location)
							}
						}
						return false
					})
				}
				for (const isotope of imported) {
					isotope.identifier = identifiers.get(isotope.identifier)!
					isotope.providerName = checksum
				}
				service.storage.markForTrim(symbol)
			})
		}
		mergeDependencySymbolsImmediately(service, exported, true, pendingUsages)
		for (const [symbol, usages] of pendingUsages) {
			if (symbol.scopes?.public?.[0]?.usages !== usages) {
				for (const type of SymbolUsageTypes) {
					for (const location of usages[type] ?? []) {
						service.storage.recordLocationRemoved(symbol, location)
					}
				}
			}
		}
		service.storage.trim()
	}

	/** Find consumer usages of the selected exported dependency isotope. */
	export function getImportedUsageContainer(
		service: SymbolService,
		symbol: Symbol,
		uri: string,
	): SymbolUsages | undefined {
		if (symbol.isLocal || service.storage.owns(symbol)) {
			return undefined
		}
		const source = Isotope.selectIsotope(symbol, uri, service.storage.resolveResourceLocation)
		if (!source?.origin) {
			return undefined
		}
		const scope = source.scope
		if (scope !== SymbolIsotopeScope.Public && scope !== SymbolIsotopeScope.Protected) {
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
			&& candidate.scope === scope
			&& (source.source === SymbolIsotopeProvider.Imported
				? candidate.providerName === source.providerName
					&& candidate.identifier === source.identifier
				: candidate.identifier
					=== JSON.stringify([candidate.providerName, 'isotope', source.identifier]))
		)
		return isotope && isotope.usages
	}

	/** Merge filtered imports, keeping their metadata identities and shared usages. */
	export function mergeDependencySymbols(
		service: SymbolService,
		table: SymbolTable,
		preserveExistingLocations: boolean = false,
		pendingUsages?: ReadonlyMap<Symbol, SymbolUsages>,
	): void {
		service.runOrDefer(() =>
			mergeDependencySymbolsImmediately(service, table, preserveExistingLocations, pendingUsages)
		)
	}

	function mergeDependencySymbolsImmediately(
		service: SymbolService,
		table: SymbolTable,
		preserveExistingLocations: boolean = false,
		pendingUsages?: ReadonlyMap<Symbol, SymbolUsages>,
	): void {
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
					service.storage.markForTrim(symbol)
				}
				for (const isotope of entry.scopes?.public ?? []) {
					const { usages: _usages, ...metadata } = isotope
					Isotope.writeIsotope(
						service,
						symbol,
						isotope.identifier,
						{ data: metadata },
						TextDocument.create('', '', 0, ''),
						undefined,
					)
				}
				if (entry.scopes?.public?.length) {
					const isotopes = symbol.scopes!.public!
					const retained = pendingUsages?.get(symbol)
					if (retained) {
						for (const isotope of isotopes) {
							isotope.usages = retained
						}
					}
					const usages = isotopes[0].usages
					const ids = new Set(entry.scopes.public.map(isotope => isotope.identifier))
					for (const usageType of SymbolUsageTypes) {
						usages[usageType] = usages[usageType]?.filter(location => {
							if (
								preserveExistingLocations || !location.importedFrom
								|| !location.isotopeIdentifier
								|| !ids.has(location.isotopeIdentifier)
							) {
								return true
							}
							service.storage.recordLocationRemoved(symbol, location)
							return false
						})
						for (const location of entry.scopes.public[0].usages[usageType] ?? []) {
							;(usages[usageType] ??= []).push(location)
							service.storage.recordLocationAdded(symbol, location)
						}
					}
				}
				for (const key of SymbolRestrictedScopeTypes) {
					for (const isotope of entry.scopes?.[key] ?? []) {
						const scopes = symbol.scopes ??= {}
						const index = scopes[key]?.findIndex(value =>
							value.identifier === isotope.identifier
						) ?? -1
						if (index >= 0) {
							for (const type of SymbolUsageTypes) {
								for (const location of scopes[key]![index].usages[type] ?? []) {
									service.storage.recordLocationRemoved(symbol, location)
								}
							}
							scopes[key]![index] = isotope
						} else {
							;(scopes[key] ??= []).push(isotope)
						}
						for (const type of SymbolUsageTypes) {
							for (const location of isotope.usages[type] ?? []) {
								service.storage.recordLocationAdded(symbol, location)
							}
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
		service.runOrDefer(() => removeDependencySymbolsImmediately(service, checksum, shouldTrim))
	}

	function removeDependencySymbolsImmediately(
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
			const removedUsages = new Set(
				SymbolRestrictedScopeTypes.flatMap(key => symbol.scopes?.[key] ?? [])
					.filter(isotope => removed.has(isotope.identifier))
					.map(isotope => isotope.usages),
			)
			for (const owner of Isotope.allDistinctUsages(symbol)) {
				for (const type of SymbolUsageTypes) {
					owner[type] = owner[type]?.filter(location => {
						if (
							!removed.has(location.isotopeIdentifier ?? '')
							&& !removedUsages.has(owner)
						) {
							return true
						}
						service.storage.recordLocationRemoved(symbol, location)
						return false
					})
				}
			}
			for (const key of SymbolScopeTypes) {
				const isotopes = symbol.scopes?.[key]
				if (isotopes) {
					symbol.scopes![key] = isotopes.filter(isotope => !removed.has(isotope.identifier))
				}
			}
			service.storage.markForTrim(symbol)
		})
		if (shouldTrim) {
			service.storage.trim()
		}
	}
}
