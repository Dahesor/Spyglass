import picomatch from 'picomatch'
import { TextDocument } from 'vscode-languageserver-textdocument'
import type {
	GlobalSymbolIsotope,
	IsotopeScope,
	Symbol,
	SymbolGlobalData,
	SymbolIsotope,
	SymbolLocation,
	SymbolUsageType,
	SymbolView,
} from './Symbol.js'
import { SymbolIsotopeProvider, SymbolIsotopeScope, SymbolUsageTypes } from './Symbol.js'
import type { SymbolAddition, SymbolAdditionUsage, SymbolUtil } from './SymbolUtil.js'

export interface SymbolIsotopeAddition {
	data?: Partial<Omit<SymbolIsotope, SymbolUsageType | 'identifier'>>
	usage?: SymbolAdditionUsage
}
const contextualSymbols = new WeakMap<Symbol, Symbol>()
const isotopeMatchers = new WeakMap<
	SymbolIsotope,
	{ patterns: string[]; match: (uri: string) => boolean }
>()

type UsageOwner = SymbolGlobalData | SymbolIsotope
interface PendingDocUsage {
	owner: UsageOwner
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
		util: SymbolUtil,
		symbol: Symbol,
		addition: SymbolAddition,
		doc: TextDocument,
		contributor: string | undefined,
	): void {
		const scope = addition.data?.scope ?? SymbolIsotopeScope.Global
		const hasMetadata = addition.data
			&& ('desc' in addition.data || 'data' in addition.data || 'scope' in addition.data
				|| 'source' in addition.data
				|| 'overrideLevel' in addition.data)
		const isReference = (addition.usage?.type ?? 'reference') === 'reference' && !hasMetadata
		const existing = selectIsotope(symbol, doc.uri)
			?? (isReference ? allIsotopes(symbol)[0] : undefined)
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
			util,
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

	/** Create or update metadata; Global/Project locations belong to the shared facet. */
	export function writeIsotope(
		util: SymbolUtil,
		symbol: Symbol,
		identifier: string,
		addition: SymbolIsotopeAddition,
		doc: TextDocument,
		contributor: string | undefined,
	): GlobalSymbolIsotope | SymbolIsotope {
		if (symbol.isLocal) {
			throw new Error('Local symbols do not support isotopes.')
		}
		if (addition.data && 'scope' in addition.data && addition.data.scope === undefined) {
			throw new Error('An isotope scope cannot be undefined.')
		}
		if (addition.data && 'source' in addition.data && addition.data.source === undefined) {
			throw new Error('An isotope source cannot be undefined.')
		}
		const facets = symbol.facets ??= {}
		let isotope: GlobalSymbolIsotope | SymbolIsotope | undefined =
			facets.isotopes?.find(value => value.identifier === identifier)
				?? facets.internal?.isotopes.find(value => value.identifier === identifier)
				?? facets.global?.isotopes.find(value => value.identifier === identifier)
		const needsSorting = !isotope
			|| (addition.data?.source !== undefined && addition.data.source !== isotope.source)
			|| (addition.data && 'overrideLevel' in addition.data
				&& addition.data.overrideLevel !== isotope?.overrideLevel)
		const oldScope = isotope && scopeOf(symbol, isotope)
		const scope = addition.data?.scope ?? oldScope
		if (scope === undefined || (!isotope && addition.data?.source === undefined)) {
			throw new Error('Creating an isotope requires a scope and source.')
		}
		if (oldScope !== undefined && oldScope !== scope) {
			throw new Error(
				'Cannot change the scope of an existing isotope; remove its contribution first.',
			)
		}

		let isotopeContainer: SymbolGlobalData | SymbolIsotope
		// Case: Global or Project scoped isotopes
		if (scope === SymbolIsotopeScope.Global || scope === SymbolIsotopeScope.Project) {
			isotopeContainer = (scope === SymbolIsotopeScope.Project)
				? facets.internal ??= { isotopes: [] }
				: facets.global ??= { isotopes: [] }
			if (!isotope) {
				isotope = { identifier, source: addition.data!.source! }
				isotopeContainer.isotopes.push(isotope)
			}
			const {
				scope: _scope,
				namespace: _namespace,
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
				isotopeContainer.isotopes.sort((a, b) =>
					(b.overrideLevel ?? 0) - (a.overrideLevel ?? 0)
					|| priority(a.source) - priority(b.source)
				)
			}
		} // Case: Restricted scoped isotopes
		else {
			if (!isotope) {
				isotope = { identifier, source: addition.data!.source!, scope }
				;(facets.isotopes ??= []).push(isotope as SymbolIsotope)
			}
			Object.assign(isotope, addition.data)
			isotopeContainer = isotope as SymbolIsotope
		}
		util.amendSymbolUsage(
			symbol,
			addition.usage && { ...addition.usage, isotopeIdentifier: identifier },
			doc,
			contributor,
			isotopeContainer,
		)
		if (addition.usage?.node) {
			addition.usage.node.symbol = symbol
		}
		util.emit('symbolAmended', { symbol })
		if (addition.usage?.fromDocDeclaration) {
			reconcileDocUsages(util, symbol)
		}
		return isotope
	}

	/** Reassign usages after declarations are added, removed or change access policy.
	 * Since the existence of a doc declaration would turn definitions to implmentations
	 * @param util The symbol utility instance.
	 * @param symbol The symbol to process.
	 */
	export function reconcileDocUsages(util: SymbolUtil, symbol: Symbol): void {
		// Petentially heavy process so we do some optimizations here.
		const usageContainers = allUsageContainers(symbol)
		const declarations = collectDocDeclarations(symbol, usageContainers)
		const pending = collectDocUsages(symbol, usageContainers)
		removeImplicitFileMetadata(symbol, declarations, pending)
		reassignDocUsages(util, symbol, declarations, pending)
	}

	// #region  reconcileDocUsage process functions

	function collectDocDeclarations(symbol: Symbol, owners: UsageOwner[]): GlobalSymbolIsotope[] {
		const declared = new Map<UsageOwner, Set<string | undefined>>()
		for (const owner of owners) {
			const identifiers = new Set<string | undefined>()
			for (const location of owner.declaration ?? []) {
				if (location.fromDocDeclaration) {
					identifiers.add(location.isotopeIdentifier)
				}
			}
			declared.set(owner, identifiers)
		}
		for (const facet of [symbol.facets?.global, symbol.facets?.internal]) {
			if (facet) {
				facet.isotopes = facet.isotopes.filter(isotope =>
					isotope.source !== SymbolIsotopeProvider.DocBlock
					|| declared.get(facet)?.has(isotope.identifier)
				)
			}
		}
		if (symbol.facets?.isotopes) {
			symbol.facets.isotopes = symbol.facets.isotopes.filter(isotope =>
				isotope.source !== SymbolIsotopeProvider.DocBlock
				|| declared.get(isotope)?.has(isotope.identifier)
			)
		}
		return allIsotopes(symbol).filter(isotope =>
			isotope.source === SymbolIsotopeProvider.DocBlock
		)
	}

	function collectDocUsages(symbol: Symbol, usageContainers: UsageOwner[]): PendingDocUsage[] {
		const metadataById = new Map<string, GlobalSymbolIsotope>()
		for (const isotope of allIsotopes(symbol)) {
			if (!metadataById.has(isotope.identifier)) {
				metadataById.set(isotope.identifier, isotope)
			}
		}
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
							|| ('source' in usages && usages.source === SymbolIsotopeProvider.Imported))
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
		symbol: Symbol,
		declarations: GlobalSymbolIsotope[],
		pending: PendingDocUsage[],
	): void {
		// An implicit file definition must not expose a doc-scoped file globally.
		if (declarations.length && symbol.facets?.global) {
			const facet = symbol.facets.global
			const retainedIds = new Set<string | undefined>()
			for (const type of SymbolUsageTypes) {
				if (type !== 'reference') {
					for (const location of facet[type] ?? []) {
						retainedIds.add(location.isotopeIdentifier)
					}
				}
			}
			const selectedByUri = new Map<string, GlobalSymbolIsotope | undefined>()
			for (const { location } of pending) {
				if (!location.fromFile && location.originalUsageType === 'definition') {
					if (!selectedByUri.has(location.uri)) {
						selectedByUri.set(location.uri, selectIsotope(symbol, location.uri))
					}
					if (selectedByUri.get(location.uri)?.source !== SymbolIsotopeProvider.DocBlock) {
						retainedIds.add(location.isotopeIdentifier)
					}
				}
			}
			facet.isotopes = facet.isotopes.filter(isotope =>
				isotope.source !== SymbolIsotopeProvider.Regular
				|| retainedIds.has(isotope.identifier)
			)
		}
	}

	function reassignDocUsages(
		util: SymbolUtil,
		symbol: Symbol,
		declarations: GlobalSymbolIsotope[],
		pending: PendingDocUsage[],
	): void {
		// Keep the first match, as pending.find did, even if it is not a file usage.
		const existingByOwner = new Map<UsageOwner, Map<string, PendingDocUsage>>()
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
		const created: { type: SymbolUsageType; location: SymbolLocation }[] = []
		const selectedByUri = new Map<string, GlobalSymbolIsotope | undefined>()
		const docOwners = new Map<UsageOwner, boolean>()
		const targetsByIsotope = new Map<
			GlobalSymbolIsotope,
			{ owner: UsageOwner; scope: IsotopeScope }
		>()
		for (const previous of pending) {
			const { location } = previous
			let targets: GlobalSymbolIsotope[]
			if (location.fromFile && declarations.length) {
				targets = declarations
			} else {
				if (!selectedByUri.has(location.uri)) {
					selectedByUri.set(location.uri, selectIsotope(symbol, location.uri))
				}
				let selected = selectedByUri.get(location.uri)
				if (!selected) {
					// Keep inaccessible references in their previous owner; they do not create visibility.
					if (!location.fromFile && declarations.length) {
						selected = declarations[0]
					}
					if (!selected) {
						selected = writeIsotope(
							util,
							symbol,
							JSON.stringify([
								SymbolIsotopeProvider.Regular,
								location.uri,
								location.contributor,
							]),
							{
								data: {
									scope: SymbolIsotopeScope.Global,
									source: SymbolIsotopeProvider.Regular,
									origin: { uri: location.uri, contributor: location.contributor },
								},
							},
							TextDocument.create(location.uri, '', 0, ''),
							location.contributor,
						)
						// Creating metadata can change the fallback for every URI.
						selectedByUri.clear()
						targetsByIsotope.clear()
						docOwners.clear()
					}
				}
				targets = [selected]
			}
			for (const target of targets) {
				let targetData = targetsByIsotope.get(target)
				if (!targetData) {
					targetData = { owner: ownerOf(symbol, target), scope: scopeOf(symbol, target) }
					targetsByIsotope.set(target, targetData)
				}
				const { owner, scope } = targetData
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
					scope >= SymbolIsotopeScope.Project ? scope : target.identifier,
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
					created.push({ type, location: relocated })
				}
				;(owner[type] ??= []).push(relocated)
				if (type === 'declaration' && relocated.fromDocDeclaration) {
					docOwners.set(owner, true)
				}
			}
		}
		for (const { type, location } of pending) {
			if (!retained.has(location)) {
				util.emit('symbolLocationRemoved', { symbol, type, location })
			}
		}
		for (const { type, location } of created) {
			util.emit('symbolLocationCreated', { symbol, type, location })
		}
	}

	// #endregion

	/** @returns List of all isotopes of the given symbol */
	export function allIsotopes(symbol: Symbol): (GlobalSymbolIsotope | SymbolIsotope)[] {
		symbol = contextualSymbols.get(symbol) ?? symbol
		return [
			...(symbol.facets?.isotopes ?? []),
			...(symbol.facets?.internal?.isotopes ?? []),
			...(symbol.facets?.global?.isotopes ?? []),
		]
	}

	/** @returns List of all isotopes that does not have a global scope */
	export function allRestrictedIsotopes(symbol: Symbol): SymbolIsotope[] {
		symbol = contextualSymbols.get(symbol) ?? symbol
		return [
			...(symbol.facets?.isotopes ?? []),
		]
	}

	/** @returns List of all containers that have the usages data */
	export function allUsageContainers(symbol: Symbol): (SymbolGlobalData | SymbolIsotope)[] {
		symbol = contextualSymbols.get(symbol) ?? symbol
		return [
			...(symbol.facets?.isotopes ?? []),
			...[symbol.facets?.internal, symbol.facets?.global].filter(
				(
					facet,
				): facet is SymbolGlobalData => !!facet,
			),
		]
	}

	/** @returns the scope of the given isotope */
	export function scopeOf(symbol: Symbol, isotope: GlobalSymbolIsotope): IsotopeScope {
		return 'scope' in isotope
			? (isotope as SymbolIsotope).scope
			: symbol.facets?.internal?.isotopes.includes(isotope)
			? SymbolIsotopeScope.Project
			: SymbolIsotopeScope.Global
	}

	/** @returns where does the given isotope belong */
	export function ownerOf(
		symbol: Symbol,
		isotope: GlobalSymbolIsotope,
	): SymbolGlobalData | SymbolIsotope {
		return 'scope' in isotope
			? isotope as SymbolIsotope
			: symbol.facets?.internal?.isotopes.includes(isotope)
			? symbol.facets.internal
			: symbol.facets!.global!
	}

	/** Select the most specific matching isotope, then its highest override level. */
	export function selectIsotope(
		symbol: Symbol,
		uri: string | undefined,
	): GlobalSymbolIsotope | SymbolIsotope | undefined {
		symbol = contextualSymbols.get(symbol) ?? symbol
		const facets = symbol.facets
		if (symbol.category === 'mcdoc' || symbol.category === 'mcdoc/dispatcher') {
			return facets?.global?.isotopes[0]
		}
		const restricted = facets?.isotopes
		if (!uri || !restricted?.length) {
			return facets?.internal?.isotopes[0] ?? facets?.global?.isotopes[0]
		}
		const namespace = uri && /\/(?:data|assets)\/([^/]+)\//.exec(uri)?.[1]
		let selected: SymbolIsotope | undefined
		for (const isotope of restricted) {
			if (isotope.namespace?.length && !isotope.namespace.includes(namespace ?? '')) {
				continue
			}
			const patterns = isotope.visibleWithin
			if (!patterns?.length) {
				continue
			}
			let cached = isotopeMatchers.get(isotope)
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
		return selected ?? facets?.internal?.isotopes[0] ?? facets?.global?.isotopes[0]
	}

	/** @returns a view of the symbol from the context of the given URI. */
	export function viewFromContext(
		symbol: Symbol | undefined,
		uri: string | undefined,
	): SymbolView | undefined {
		if (!symbol) {
			return undefined
		}
		symbol = contextualSymbols.get(symbol) ?? symbol
		const isotope = selectIsotope(symbol, uri)
		if (!isotope) {
			return undefined
		}
		const view: SymbolView = { ...symbol, desc: isotope.desc, data: isotope.data }
		const owner = ownerOf(symbol, isotope)
		for (const usage of SymbolUsageTypes) {
			view[usage] = owner[usage]
		}
		contextualSymbols.set(view, symbol)
		return view
	}

	/** @returns `true` if the symbol is visible from the context of the given URI. */
	export function isVisible(symbol: Symbol, uri: string | undefined): boolean {
		return !!selectIsotope(symbol, uri)
	}

	/** @returns `true` if the symbol is contributed by a file itself instead of its content. */
	export function isFromFile(symbol: Symbol | undefined): boolean {
		return !!symbol
			&& allUsageContainers(symbol).some(owner =>
				owner.definition?.some(location => location.fromFile)
				|| owner.implementation?.some(location => location.fromFile)
			)
	}

	/**
	 * @param symbol The symbol to check access for.
	 * @param uri The URI of the file from which access is being checked.
	 * @returns `true` if a file symbol is defined but cannot be accessed here
	 */
	export function hasNoAccessToFileSymbol(symbol: Symbol | undefined, uri: string): boolean {
		// Visible symbols cannot violate access, regardless of how many usages they have.
		return !!symbol && !isVisible(symbol, uri) && isFromFile(symbol)
	}

	/** Prune metadata affected by removed locations and reconcile remaining doc usages. */
	export function cleanupAfterLocationRemoval(
		util: SymbolUtil,
		symbol: Symbol,
		removedIds: ReadonlySet<string>,
		needsReconciliation = true,
	): void {
		for (const facet of [symbol.facets?.global, symbol.facets?.internal]) {
			if (!facet) {
				continue
			}
			const previousCount = facet.isotopes.length
			const retainedIds = new Set<string>()
			for (const type of SymbolUsageTypes) {
				for (const location of facet[type] ?? []) {
					if (location.isotopeIdentifier) {
						retainedIds.add(location.isotopeIdentifier)
					}
				}
			}
			facet.isotopes = facet.isotopes.filter(isotope =>
				!removedIds.has(isotope.identifier)
				|| retainedIds.has(isotope.identifier)
			)
			needsReconciliation ||= previousCount !== facet.isotopes.length
		}
		if (symbol.facets?.isotopes) {
			const previousCount = symbol.facets.isotopes.length
			symbol.facets.isotopes = symbol.facets.isotopes.filter(isotope =>
				!removedIds.has(isotope.identifier)
				|| SymbolUsageTypes.some(type => isotope[type]?.length)
			)
			needsReconciliation ||= previousCount !== symbol.facets.isotopes.length
		}
		if (needsReconciliation) {
			reconcileDocUsages(util, symbol)
		}
	}

	/** Route command usages into the selected isotope
	 * @return usages that needs a new symbol for.
	 */
	export function enterCommand(
		util: SymbolUtil,
		raw: Symbol | undefined,
		addition: SymbolAddition,
		doc: TextDocument,
		contributor: string | undefined,
	): SymbolAdditionUsage | undefined {
		const isotope = raw && Isotope.selectIsotope(raw, doc.uri)
		const originalType = addition.usage?.type ?? 'reference'
		const usage: SymbolAdditionUsage = { ...addition.usage, originalUsageType: originalType }
		if (raw && isotope) {
			if (addition.data) {
				util.amendSymbol(raw, { data: addition.data }, doc, contributor)
			}
			const owner = Isotope.ownerOf(raw, isotope)
			const docDeclared = owner.declaration?.some(location => location.fromDocDeclaration)
			Isotope.writeIsotope(
				util,
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
			// An inaccessible symbol retains the reference without acquiring a public facet.
			if (raw && originalType === 'reference') {
				const owner = Isotope.allIsotopes(raw)[0]
				if (owner) {
					Isotope.writeIsotope(
						util,
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
