import { TextDocument } from 'vscode-languageserver-textdocument'
import type { ResourceLocation } from '../../common/index.js'
import type { SymbolAddition, SymbolAdditionUsage } from '../Handle.js'
import type { SymbolService } from '../Service.js'
import type {
	Symbol,
	SymbolIsotope,
	SymbolLocation,
	SymbolUsages,
	SymbolUsageType,
	SymbolView,
} from '../Symbol.js'
import {
	SymbolGlobalScopeTypes,
	SymbolIsotopeProvider,
	SymbolIsotopeScope,
	SymbolRestrictedScopeTypes,
	SymbolScopeTypes,
	SymbolUsageTypes,
} from '../Symbol.js'
import { matchesVisibility, type ResourceLocationResolver } from './visibility.js'

export interface SymbolIsotopeAddition {
	data?: Partial<Omit<SymbolIsotope, 'usages' | 'identifier'>>
	usage?: SymbolAdditionUsage
}
const contextualSymbols = new WeakMap<Symbol, Symbol>()

interface PendingDocUsage {
	owner: SymbolUsages
	type: SymbolUsageType
	location: SymbolLocation
}

/** Match the same fields as the old file-location search, including absent ranges. */
function fileUsageKey(location: SymbolLocation, type: SymbolUsageType): string {
	return JSON.stringify([location.uri, location.contributor, location.range, type])
}

/** Isotope storage, visibility and doc contribution reconciliation. */
export namespace Isotope {
	export function rawSymbol(symbol: Symbol): Symbol {
		return contextualSymbols.get(symbol) ?? symbol
	}
	export function isContextualView(symbol: Symbol): boolean {
		return contextualSymbols.has(symbol)
	}

	/**
	 * Amend the given symbol with the provided addition
	 * @param symbol The symbol to be amended.
	 * @param addition The addition containing new metadata and usage information.
	 * @param doc The document in which the amendment is taking place.
	 * @param contributor The contributor responsible for the amendment.
	 */
	export function amendSymbol(
		service: SymbolService,
		symbol: Symbol,
		addition: SymbolAddition,
		doc: TextDocument,
		contributor: string | undefined,
	): void {
		const scope = addition.data?.scope ?? SymbolIsotopeScope.Public
		const hasMetadata = addition.data
			&& ('desc' in addition.data || 'data' in addition.data || 'scope' in addition.data
				|| 'source' in addition.data || 'deprecated' in addition.data
				|| 'overrideLevel' in addition.data)
		const isReference = (addition.usage?.type ?? 'reference') === 'reference' && !hasMetadata
		const existing = selectIsotope(symbol, doc.uri, service.storage.resolveResourceLocation)
			?? (isReference ? allIsotopesOf(symbol)[0] : undefined)
		const source = addition.data?.source
			?? (addition.usage?.fromDocDeclaration
				? SymbolIsotopeProvider.DocBlock
				: contributor?.startsWith('symbol_registrar/')
				? SymbolIsotopeProvider.Builtin
				: SymbolIsotopeProvider.Regular)
		const identifier = symbol.category === 'mcdoc' || symbol.category === 'mcdoc/dispatcher'
			? 'regular'
			: isReference && existing
			? existing.identifier
			: JSON.stringify([source, doc.uri, contributor])
		writeIsotope(
			service,
			symbol,
			identifier,
			{
				data: isReference && existing
					? undefined
					: {
						scope,
						source,
						origin: { uri: doc.uri, contributor },
						...(addition.data && 'desc' in addition.data ? { desc: addition.data.desc } : {}),
						...(addition.data && 'deprecated' in addition.data
							? { deprecated: addition.data.deprecated }
							: {}),
						...(addition.data && 'data' in addition.data ? { data: addition.data.data } : {}),
						...(addition.data && 'overrideLevel' in addition.data
							? { overrideLevel: addition.data.overrideLevel }
							: {}),
					},
				usage: addition.usage,
			},
			doc,
			contributor,
		)
	}

	/** Create or update metadata */
	export function writeIsotope(
		service: SymbolService,
		symbol: Symbol,
		identifier: string,
		addition: SymbolIsotopeAddition,
		doc: TextDocument,
		contributor: string | undefined,
	): SymbolIsotope {
		if (symbol.isLocal) {
			throw new Error('Local symbols do not support isotopes.')
		}
		if (addition.data && 'scope' in addition.data && addition.data.scope === undefined) {
			throw new Error('An isotope scope cannot be undefined.')
		}
		if (addition.data && 'source' in addition.data && addition.data.source === undefined) {
			throw new Error('An isotope source cannot be undefined.')
		}
		const scopes = symbol.scopes ??= {}
		let isotope: SymbolIsotope | undefined
		for (const key of SymbolScopeTypes) {
			isotope = scopes[key]?.find(value => value.identifier === identifier)
			if (isotope) {
				break
			}
		}
		const needsSorting = !isotope
			|| (addition.data?.source !== undefined && addition.data.source !== isotope.source)
			|| (addition.data && 'overrideLevel' in addition.data
				&& addition.data.overrideLevel !== isotope?.overrideLevel)
		const oldScope = isotope?.scope
		const scope = addition.data?.scope ?? oldScope
		if (scope === undefined || (!isotope && addition.data?.source === undefined)) {
			throw new Error('Creating an isotope requires a scope and source.')
		}
		if (oldScope !== undefined && oldScope !== scope) {
			throw new Error(
				'Cannot change the scope of an existing isotope; remove its contribution first.',
			)
		}

		// Case: Public or Internal scoped isotopes
		if (scope === SymbolIsotopeScope.Public || scope === SymbolIsotopeScope.Internal) {
			const isotopeContainer = (scope === SymbolIsotopeScope.Internal)
				? scopes.internal ??= []
				: scopes.public ??= []
			if (!isotope) {
				isotope = {
					identifier,
					source: addition.data!.source!,
					scope,
					usages: isotopeContainer[0]?.usages ?? {},
				}
				isotopeContainer.push(isotope)
			}
			const {
				visibleWithin: _visibleWithin,
				...metadata
			} = addition.data ?? {}
			Object.assign(isotope, metadata)
			const priority = (source: SymbolIsotopeProvider) =>
				source === SymbolIsotopeProvider.DocBlock
					? 0
					: source === SymbolIsotopeProvider.Regular
					? 1
					: source === SymbolIsotopeProvider.Builtin
					? 2
					: 3
			if (needsSorting) {
				isotopeContainer.sort((a, b) =>
					(b.overrideLevel ?? 0) - (a.overrideLevel ?? 0)
					|| priority(a.source) - priority(b.source)
				)
			}
		} // Case: Restricted scoped isotopes
		else {
			if (!isotope) {
				isotope = { identifier, source: addition.data!.source!, scope, usages: {} }
				;(scopes.restricted ??= []).push(isotope)
			}
			Object.assign(isotope, addition.data)
		}
		service.appendSymbolUsage(
			symbol,
			addition.usage && { ...addition.usage, isotopeIdentifier: identifier },
			doc,
			contributor,
			isotope.usages,
		)
		if (addition.usage?.node) {
			addition.usage.node.symbol = symbol
		}

		if (addition.usage?.fromDocDeclaration) {
			reconcileDocUsages(service, symbol)
		}
		return isotope
	}

	/** Reassign usages after declarations are added, removed or change access policy.
	 * Since the existence of a doc declaration would turn definitions to implmentations
	 * @param service The symbol service instance.
	 * @param symbol The symbol to process.
	 */
	export function reconcileDocUsages(service: SymbolService, symbol: Symbol): void {
		// Petentially heavy process so we do some optimizations here.
		const usageContainers = allDistinctUsages(symbol)
		const publicUsages = symbol.scopes?.public?.[0]?.usages
		const declarations = collectDocDeclarations(symbol, usageContainers)
		const pending = collectDocUsages(symbol, usageContainers)
		removeImplicitFileMetadata(service, symbol, declarations, pending)
		reassignDocUsages(service, symbol, declarations, pending, publicUsages)
		removeDetachedUsages(service, symbol, usageContainers)
	}

	function removeDetachedUsages(
		service: SymbolService,
		symbol: Symbol,
		usageContainers: SymbolUsages[],
	): void {
		const retainedUsages = new Set(allDistinctUsages(symbol))
		for (const usages of usageContainers) {
			if (!retainedUsages.has(usages)) {
				for (const type of SymbolUsageTypes) {
					for (const location of usages[type] ?? []) {
						service.storage.recordLocationRemoved(symbol, location)
					}
					if (usages[type]) {
						usages[type] = []
					}
				}
			}
		}
	}

	// #region  reconcileDocUsage process functions

	function collectDocDeclarations(symbol: Symbol, owners: SymbolUsages[]): SymbolIsotope[] {
		const declared = new Map<SymbolUsages, Set<string | undefined>>()
		for (const owner of owners) {
			const identifiers = new Set<string | undefined>()
			for (const location of owner.declaration ?? []) {
				if (location.fromDocDeclaration) {
					identifiers.add(location.isotopeIdentifier)
				}
			}
			declared.set(owner, identifiers)
		}
		for (const key of SymbolScopeTypes) {
			const isotopes = symbol.scopes?.[key]
			if (isotopes) {
				symbol.scopes![key] = isotopes.filter(isotope =>
					isotope.source !== SymbolIsotopeProvider.DocBlock
					|| declared.get(isotope.usages)?.has(isotope.identifier)
				)
			}
		}
		return allIsotopesOf(symbol).filter(isotope =>
			isotope.source === SymbolIsotopeProvider.DocBlock
		)
	}

	function collectDocUsages(symbol: Symbol, usageContainers: SymbolUsages[]): PendingDocUsage[] {
		const metadataById = new Map<string, SymbolIsotope>()
		for (const isotope of allIsotopesOf(symbol)) {
			if (!metadataById.has(isotope.identifier)) {
				metadataById.set(isotope.identifier, isotope)
			}
		}
		const importedOwners = new Set(
			SymbolRestrictedScopeTypes.flatMap(key => symbol.scopes?.[key] ?? [])
				.filter(isotope => isotope.source === SymbolIsotopeProvider.Imported)
				.map(isotope => isotope.usages),
		)
		const pending: PendingDocUsage[] = []
		for (const usages of usageContainers) {
			for (const type of SymbolUsageTypes) {
				usages[type] = usages[type]?.filter(location => {
					if (location.importedFrom) {
						return true
					}
					const metadata = location.isotopeIdentifier === undefined
						? undefined
						: metadataById.get(location.isotopeIdentifier)
					if (
						location.fromFile
						&& (metadata?.source === SymbolIsotopeProvider.Imported
							|| importedOwners.has(usages))
					) {
						return true
					}
					if (!location.fromFile && !location.originalUsageType) {
						return true
					}
					pending.push({ owner: usages, type, location })
					return false
				})
			}
		}
		return pending
	}

	function removeImplicitFileMetadata(
		service: SymbolService,
		symbol: Symbol,
		declarations: SymbolIsotope[],
		pending: PendingDocUsage[],
	): void {
		// An implicit file definition must not expose a doc-scoped file globally.
		if (declarations.length && symbol.scopes?.public) {
			const facet = symbol.scopes.public
			const retainedIds = new Set<string | undefined>()
			for (const type of SymbolUsageTypes) {
				if (type !== 'reference') {
					for (const location of facet[0]?.usages[type] ?? []) {
						retainedIds.add(location.isotopeIdentifier)
					}
				}
			}
			const selectedByUri = new Map<string, SymbolIsotope | undefined>()
			for (const { location } of pending) {
				if (!location.fromFile && location.originalUsageType === 'definition') {
					if (!selectedByUri.has(location.uri)) {
						selectedByUri.set(
							location.uri,
							selectIsotope(symbol, location.uri, service.storage.resolveResourceLocation),
						)
					}
					if (selectedByUri.get(location.uri)?.source !== SymbolIsotopeProvider.DocBlock) {
						retainedIds.add(location.isotopeIdentifier)
					}
				}
			}
			symbol.scopes.public = facet.filter(isotope =>
				isotope.source !== SymbolIsotopeProvider.Regular
				|| retainedIds.has(isotope.identifier)
			)
		}
	}

	function reassignDocUsages(
		service: SymbolService,
		symbol: Symbol,
		declarations: SymbolIsotope[],
		pending: PendingDocUsage[],
		publicUsages: SymbolUsages | undefined,
	): void {
		// Keep the first match, as pending.find did, even if it is not a file usage.
		const existingByOwner = new Map<SymbolUsages, Map<string, PendingDocUsage>>()
		for (const previous of pending.some(value => value.location.fromFile) ? pending : []) {
			let index = existingByOwner.get(previous.owner)
			if (!index) {
				existingByOwner.set(previous.owner, index = new Map())
			}
			const key = fileUsageKey(previous.location, previous.type)
			if (!index.has(key)) {
				index.set(key, previous)
			}
		}
		const fileLocations = new Set<string>()
		const retained = new Set<SymbolLocation>()
		const created: SymbolLocation[] = []
		const selectedByUri = new Map<string, SymbolIsotope | undefined>()
		const docOwners = new Map<SymbolUsages, boolean>()
		for (const previous of pending) {
			const { location } = previous
			let targets: SymbolIsotope[]
			if (location.fromFile && declarations.length) {
				targets = declarations
			} else {
				if (!selectedByUri.has(location.uri)) {
					selectedByUri.set(
						location.uri,
						selectIsotope(symbol, location.uri, service.storage.resolveResourceLocation),
					)
				}
				let selected = selectedByUri.get(location.uri)
				if (!selected) {
					// Keep inaccessible references in their previous owner; they do not create visibility.
					if (!location.fromFile && declarations.length) {
						selected = declarations[0]
					}
					if (!selected) {
						selected = writeIsotope(
							service,
							symbol,
							JSON.stringify([
								SymbolIsotopeProvider.Regular,
								location.uri,
								location.contributor,
							]),
							{
								data: {
									scope: SymbolIsotopeScope.Public,
									source: SymbolIsotopeProvider.Regular,
									origin: { uri: location.uri, contributor: location.contributor },
								},
							},
							TextDocument.create(location.uri, '', 0, ''),
							location.contributor,
						)
						if (publicUsages && symbol.scopes?.public?.length === 1) {
							selected.usages = publicUsages
						}
						// Creating metadata can change the fallback for every URI.
						selectedByUri.clear()
						docOwners.clear()
					}
				}
				targets = [selected]
			}
			for (const target of targets) {
				const { usages: owner, scope } = target
				if (!docOwners.has(owner)) {
					docOwners.set(
						owner,
						owner.declaration?.some(value => value.fromDocDeclaration) ?? false,
					)
				}
				const isDoc = docOwners.get(owner)
				const original = location.originalUsageType
					?? (location.fromFile ? 'definition' : 'reference')
				const type = original === 'definition' && isDoc ? 'implementation' : original
				const key = fileUsageKey(location, type)
				const dedupKey = JSON.stringify([
					scope >= SymbolIsotopeScope.Internal ? scope : target.identifier,
					key,
				])
				if (location.fromFile && fileLocations.has(dedupKey)) {
					continue
				}
				fileLocations.add(dedupKey)
				const existing = location.fromFile
					? existingByOwner.get(owner)?.get(key)
					: previous.owner === owner && previous.type === type
					? previous
					: undefined
				const relocated = existing
					? existing.location
					: { ...location, isotopeIdentifier: target.identifier }
				if (existing) {
					existing.location.isotopeIdentifier = target.identifier
					retained.add(existing.location)
				} else {
					created.push(relocated)
				}
				;(owner[type] ??= []).push(relocated)
				if (type === 'declaration' && relocated.fromDocDeclaration) {
					docOwners.set(owner, true)
				}
			}
		}
		for (const { location } of pending) {
			if (!retained.has(location)) {
				service.storage.recordLocationRemoved(symbol, location)
			}
		}
		for (const location of created) {
			service.storage.recordLocationAdded(symbol, location)
		}
	}

	// #endregion

	/** @returns List of all isotopes of the given symbol */
	export function allIsotopesOf(symbol: Symbol): SymbolIsotope[] {
		symbol = contextualSymbols.get(symbol) ?? symbol
		return SymbolScopeTypes.flatMap(key => symbol.scopes?.[key] ?? [])
	}

	/** Returns each usage storage object once, even when multiple isotopes share it. */
	export function allDistinctUsages(symbol: Symbol): SymbolUsages[] {
		return [...new Set(allIsotopesOf(symbol).map(isotope => isotope.usages))]
	}

	/** Select the most specific matching isotope, then its highest override level. */
	export function selectIsotope(
		symbol: Symbol,
		uri: string | undefined,
		resolve?: ResourceLocationResolver,
	): SymbolIsotope | undefined {
		symbol = contextualSymbols.get(symbol) ?? symbol
		const scopes = symbol.scopes
		if (symbol.category === 'mcdoc' || symbol.category === 'mcdoc/dispatcher') {
			return scopes?.public?.[0]
		}
		if (!uri || !SymbolRestrictedScopeTypes.some(key => scopes?.[key]?.length)) {
			return scopes?.internal?.[0] ?? scopes?.public?.[0]
		}
		let selected: SymbolIsotope | undefined
		let location: ResourceLocation | undefined
		let resolved = false
		for (const key of SymbolRestrictedScopeTypes) {
			for (const isotope of scopes?.[key] ?? []) {
				const visibility = isotope.visibleWithin
				if (!visibility?.length) {
					continue
				}
				if (
					!resolved
					&& visibility.some(rule => rule.namespace !== undefined || rule.path !== undefined)
				) {
					location = resolve?.(uri)
					resolved = true
				}
				if (!matchesVisibility(visibility, uri, location)) {
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
		}
		return selected ?? scopes?.internal?.[0] ?? scopes?.public?.[0]
	}

	/** @returns a view of the symbol from the context of the given URI. */
	export function resolveFromContext(
		symbol: Symbol,
		uri: string | undefined,
		resolve?: ResourceLocationResolver,
	): SymbolView | undefined {
		symbol = contextualSymbols.get(symbol) ?? symbol
		const isotope = selectIsotope(symbol, uri, resolve)
		if (!isotope) {
			return undefined
		}
		const view: SymbolView = {
			...symbol,
			desc: isotope.desc,
			data: isotope.data,
			deprecated: isotope.deprecated,
		}
		const owner = isotope.usages
		for (const usage of SymbolUsageTypes) {
			view[usage] = owner[usage]
		}
		contextualSymbols.set(view, symbol)
		return view
	}

	/** @returns `true` if the symbol has any visible isotope from the the given URI. */
	export function isVisible(
		symbol: Symbol,
		uri: string | undefined,
		resolve?: ResourceLocationResolver,
	): boolean {
		symbol = contextualSymbols.get(symbol) ?? symbol
		const scopes = symbol.scopes
		if (symbol.category === 'mcdoc' || symbol.category === 'mcdoc/dispatcher') {
			return !!scopes?.public?.length
		}
		if (SymbolGlobalScopeTypes.some(key => scopes?.[key]?.length)) {
			return true
		}
		if (!uri || !SymbolRestrictedScopeTypes.some(key => scopes?.[key]?.length)) {
			return false
		}
		return hasVisibleRestrictedIsotope(scopes, uri, resolve)
	}

	function hasVisibleRestrictedIsotope(
		scopes: Symbol['scopes'],
		uri: string,
		resolve: ResourceLocationResolver | undefined,
	): boolean {
		let location: ResourceLocation | undefined
		let resolved = false
		for (const key of SymbolRestrictedScopeTypes) {
			for (const isotope of scopes?.[key] ?? []) {
				const visibility = isotope.visibleWithin
				if (!visibility?.length) {
					continue
				}
				if (
					!resolved
					&& visibility.some(rule => rule.namespace !== undefined || rule.path !== undefined)
				) {
					location = resolve?.(uri)
					resolved = true
				}
				if (matchesVisibility(visibility, uri, location)) {
					return true
				}
			}
		}
		return false
	}

	/** Prune metadata affected by removed locations and reconcile remaining doc usages. */
	export function cleanupAfterLocationRemoval(
		service: SymbolService,
		symbol: Symbol,
		removedIds: ReadonlySet<string>,
		needsReconciliation = true,
	): void {
		const previousUsages = allDistinctUsages(symbol)
		for (const key of SymbolGlobalScopeTypes) {
			const scope = symbol.scopes?.[key]
			if (!scope) {
				continue
			}
			const previousCount = scope.length
			const unusedIds = new Set(
				scope.filter(isotope => removedIds.has(isotope.identifier))
					.map(isotope => isotope.identifier),
			)
			if (!unusedIds.size) {
				continue
			}
			usages:
			for (const type of SymbolUsageTypes) {
				for (const location of scope[0]?.usages[type] ?? []) {
					if (location.isotopeIdentifier) {
						unusedIds.delete(location.isotopeIdentifier)
						if (!unusedIds.size) {
							break usages
						}
					}
				}
			}
			if (!unusedIds.size) {
				continue
			}
			symbol.scopes![key] = scope.filter(isotope => !unusedIds.has(isotope.identifier))
			needsReconciliation ||= previousCount !== symbol.scopes![key]!.length
		}
		for (const key of SymbolRestrictedScopeTypes) {
			const isotopes = symbol.scopes?.[key]
			if (isotopes) {
				symbol.scopes![key] = isotopes.filter(isotope =>
					!removedIds.has(isotope.identifier)
					|| SymbolUsageTypes.some(type => isotope.usages[type]?.length)
				)
				needsReconciliation ||= isotopes.length !== symbol.scopes![key]!.length
			}
		}
		if (needsReconciliation) {
			reconcileDocUsages(service, symbol)
		}
		removeDetachedUsages(service, symbol, previousUsages)
	}

	/** Route in file usages into the selected isotope
	 * @return usages that needs a new symbol for.
	 */
	export function enterInFileUsage(
		service: SymbolService,
		raw: Symbol | undefined,
		addition: SymbolAddition,
		doc: TextDocument,
		contributor: string | undefined,
	): SymbolAdditionUsage | undefined {
		const isotope = raw
			? selectIsotope(raw, doc.uri, service.storage.resolveResourceLocation)
			: undefined
		const originalType = addition.usage?.type ?? 'reference'
		const usage: SymbolAdditionUsage = { ...addition.usage, originalUsageType: originalType }
		if (raw && isotope) {
			if (addition.data) {
				service.amendSymbol(raw, { data: addition.data }, doc, contributor)
			}
			const owner = isotope.usages
			const docDeclared = owner.declaration?.some(location => location.fromDocDeclaration)
			writeIsotope(
				service,
				raw,
				isotope.identifier,
				{
					usage: {
						...usage,
						type: originalType === 'definition' && docDeclared
							? 'implementation'
							: originalType,
					},
				},
				doc,
				contributor,
			)
		} else {
			if (raw && originalType === 'reference') {
				const owner = allIsotopesOf(raw)[0]
				if (owner) {
					writeIsotope(
						service,
						raw,
						owner.identifier,
						{ usage },
						doc,
						contributor,
					)
				}
				return undefined
			}
			return usage
		}
		return undefined
	}
}
