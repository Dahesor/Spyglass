import { TextDocument } from 'vscode-languageserver-textdocument'
import type { AstNode } from '../node/index.js'
import { Range, type RangeLike } from '../source/index.js'
import { LocalSymbol } from './local.js'
import type { SymbolService } from './Service.js'
import type {
	IsotopeScope,
	Symbol,
	SymbolIsotopeProvider,
	SymbolLocationMetadata,
	SymbolMap,
	SymbolMetadata,
	SymbolUsageType,
	SymbolView,
} from './Symbol.js'
import { type LookupResult, SymbolUtil } from './util.js'
import { Isotope, type SymbolIsotopeAddition } from './util/isotope.js'

export enum SymbolEnterType {
	None = 'none',
	File = 'file',
	InFileSymbol = 'inFileSymbol',
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
	 * The type of this usage.
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
export interface SymbolAdditionUsageWithNode extends SymbolAdditionUsageBase {
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
export namespace SymbolAdditionUsageWithNode {
	/* istanbul ignore next */
	export function is(
		usage: SymbolAdditionUsage | undefined,
	): usage is SymbolAdditionUsageWithNode {
		return !!usage?.node
	}
}

type HandleCallback<S extends SymbolView | undefined = SymbolView | undefined> = (
	this: SymbolHandle,
	symbol: S,
	handle: SymbolHandle,
) => unknown
type QueryMemberCallback = (this: void, handle: SymbolHandle) => unknown

/* istanbul ignore next */
/**
 * A handle for interacting with a specific symbol within a given context.
 *
 * Holdes a reference to the {@link SymbolService} that created it.
 */
export class SymbolHandle {
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
	 * The map where the target symbol is stored. `undefined` if the map hasn't been created yet.
	 */
	#map: SymbolMap | undefined
	#parentSymbol:
		| Symbol
		| undefined
	/**
	 * The target symbol to handle. `undefined` if the symbol hasn't been created yet.
	 */
	#symbol:
		| Symbol
		| undefined
	/**
	 * Reference to the {@link SymbolService} where this query was created.
	 */
	readonly service: SymbolService

	constructor(
		{ category, contributor, doc, map, parentSymbol, path, symbol, service, lookup, getRootMap }:
			{
				category: string
				contributor: string | undefined
				doc: TextDocument | string
				map: SymbolMap | undefined
				parentSymbol: Symbol | undefined
				path: readonly string[]
				symbol: Symbol | undefined
				service: SymbolService
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
		this.service = service
		this.#lookup = lookup
		this.#getRootMap = getRootMap
	}

	/**
	 * @returns The target symbol.
	 */
	get symbol(): Symbol | undefined {
		return this.#symbol
	}
	heyGimmeDaSymbol() {
		return this.#symbol
	}

	/**
	 * @returns the target symbol's view in the context of this handle's document.
	 * Returns `undefined` if no symbol is selected or no view is available.
	 */
	get symbolView(): SymbolView | undefined {
		return this.service.viewFromContext(this.#symbol, this.#doc.uri)
	}

	/**
	 * The selected symbol's members visible from this handle's document.
	 * For an empty path, returns the visible symbols in the category's root map.
	 */
	get visibleMembers(): SymbolMap {
		return this.service.filterVisibleSymbolsInMap(
			this.#doc.uri,
			this.path.length === 0 ? this.#map : this.#symbol?.members,
		)
	}

	get isLocalSymbol(): boolean {
		if (LocalSymbol.is(this.#symbol)) {
			return true
		}
		if (LocalSymbol.isMap(this.#map)) {
			return true
		}
		if (LocalSymbol.is(this.#parentSymbol)) {
			return true
		}
		return false
	}

	/**
	 * @returns the data of the target symbol from the handle's context.
	 * Returns `undefined` if the symbol does not exist or the data does not match the predicate.
	 */
	getData<T>(predicate: (this: void, value: unknown) => value is T): T | undefined {
		const data = this.symbolView?.data
		return predicate(data) ? data : undefined
	}

	with(fn: QueryMemberCallback): this {
		fn(this)
		return this
	}

	if(
		predicate: (this: void, symbol: SymbolView | undefined) => symbol is undefined,
		fn: HandleCallback<undefined>,
	): this
	if(
		predicate: (this: void, symbol: SymbolView | undefined) => symbol is SymbolView,
		fn: HandleCallback<SymbolView>,
	): this
	if(predicate: HandleCallback, fn: HandleCallback): this
	if(predicate: HandleCallback, fn: HandleCallback<any>): this {
		if (predicate.call(this, this.symbolView, this)) {
			fn.call(this, this.symbolView, this)
			this.#hasTriggeredIf = true
		}
		return this
	}

	/**
	 * Calls `fn` if the queried symbol does not exist.
	 */
	ifUnknown(fn: HandleCallback<undefined>): this {
		return this.if((s) => s === undefined, fn as HandleCallback)
	}

	/**
	 * Calls `fn` if the queried symbol exists (i.e. has any of declarations/definitions/implementations/references/typeDefinitions).
	 */
	ifKnown(fn: HandleCallback<SymbolView>): this {
		return this.if((s) => s !== undefined, fn as HandleCallback)
	}

	/**
	 * Calls `fn` if the queried symbol has declarations or definitions.
	 */
	ifDeclared(fn: HandleCallback<SymbolView>): this {
		return this.if((s): s is SymbolView => SymbolUtil.isDeclared(s), fn)
	}

	/**
	 * Calls `fn` if the queried symbol has definitions, or both declarations and implementations.
	 */
	ifDefined(fn: HandleCallback<SymbolView>): this {
		return this.if(SymbolUtil.isDefined, fn)
	}

	/**
	 * Calls `fn` if the queried symbol has implementations or definitions.
	 */
	ifImplemented(fn: HandleCallback<SymbolView>): this {
		return this.if(SymbolUtil.isImplemented, fn)
	}

	/**
	 * Calls `fn` if the queried symbol has references.
	 */
	ifReferenced(fn: HandleCallback<SymbolView>): this {
		return this.if(SymbolUtil.isReferenced, fn)
	}

	/**
	 * Calls `fn` if the queried symbol has type definitions.
	 */
	ifTypeDefined(fn: HandleCallback<SymbolView>): this {
		return this.if(SymbolUtil.isTypeDefined, fn)
	}

	/**
	 * Calls `fn` if none of the former `if` conditions are met.
	 */
	else(fn: HandleCallback): this {
		if (!this.#hasTriggeredIf) {
			fn.call(this, this.symbolView, this)
		}
		return this
	}

	/**
	 * Enters the target symbol if none of the former `if` conditions are met.
	 */
	elseEnter(symbol: SymbolAddition, type: SymbolEnterType = SymbolEnterType.None): this {
		return this.else(() => this.enter(symbol as any, type))
	}

	/**
	 * Resolves the queried symbol if it is an alias and if none of the former `if` conditions are met.
	 *
	 * @throws If the current symbol points to an non-existent symbol.
	 */
	elseResolveAlias(): this {
		return this.else(() => this.resolveAlias())
	}

	/**
	 * Enters the target symbol.
	 *
	 * @throws If the parent of this symbol doesn't exist either.
	 */
	@delayModeSupport
	enter(addition: SymbolAddition, type: SymbolEnterType = SymbolEnterType.None): this {
		switch (type) {
			case SymbolEnterType.None:
				this.enterImmediately(addition)
				break
			case SymbolEnterType.File:
				this.enterFileDefinition(addition)
				break
			case SymbolEnterType.InFileSymbol:
				this.enterInFileSymbol(addition)
				break
		}
		return this
	}

	/**
	 * Create or amend the specified isotope of the target symbol.
	 * Creates the target symbol if it does not exist.
	 *
	 * @param identifier The isotope identifier, should be unique within the target symbol.
	 * @param addition The metadata to merge and usage to append.
	 * @returns This handle.
	 * @throws If the target is local, the parent is missing, or the isotope
	 * metadata is invalid.
	 */
	@delayModeSupport
	enterIsotope(identifier: string, addition: SymbolIsotopeAddition): this {
		if (this.isLocalSymbol) {
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
			this.#symbol = this.service.createSymbol(
				{
					parentSymbol: this.#parentSymbol,
					map: this.#map,
					category: this.category,
					path: this.path,
					identifier: this.path[this.path.length - 1],
				},
				{},
				this.#doc,
				this.#currentContributor,
			)
		}
		if (this.#createdWithUri && SymbolAdditionUsageWithRange.is(addition.usage)) {
			addition.usage.range = Range.create(0, 0)
		}
		Isotope.writeIsotope(
			this.service,
			this.#symbol!,
			identifier,
			addition,
			this.#doc,
			this.#currentContributor,
		)
		return this
	}

	/**
	 * Amends the queried symbol if the queried symbol exists
	 * (i.e. has any of declarations/definitions/implementations/references/typeDefinitions) and is visible at the current scope.
	 *
	 * This is equivalent to calling
	 * ```typescript
	 * handle.ifKnown(function () {
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
			const result = this.service.resolveAlias(this.#symbol)
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
		const memberQueryResult = new SymbolHandle({
			category: this.category,
			doc: memberDoc,
			contributor: this.#currentContributor,
			map: memberMap,
			parentSymbol: this.#symbol,
			path: [...this.path, identifier],
			symbol: memberSymbol,
			service: this.service,
			lookup: this.#lookup,
			getRootMap: this.#getRootMap,
		})
		fn(memberQueryResult)

		return this
	}

	/**
	 * Do something with this handle on each value in a given iterable. The handle itself will be included
	 * in the callback function as the second parameter.
	 */
	onEach<T>(values: Iterable<T>, fn: (this: this, value: T, query: this) => unknown): this {
		for (const value of values) {
			fn.call(this, value, this)
		}
		return this
	}

	/** Do something with each member of the current symbol. */
	forEachMember(fn: (this: void, identifier: string, query: SymbolHandle) => unknown): this {
		return this.onEach(
			Object.keys(this.#symbol?.members ?? {}),
			(identifier) => this.member(identifier, (query) => fn(identifier, query)),
		)
	}

	get representation() {
		return `${this.category}.${this.path.join('/')}`
	}

	/** Bind a symbol defined by the file itself, rather than its contents. */
	private enterFileDefinition(addition: SymbolAddition): this {
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
			Isotope.reconcileDocUsages(this.service, this.#symbol!)
		}
		return this
	}

	private getMap(): SymbolMap {
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
		throw new Error('Could not find the map for “' + this.representation + '”')
	}

	private enterImmediately(addition: SymbolAddition): void {
		// Treat `usage.range` as `[0, 0)` if this class was constructed with a string URI (instead of a `TextDocument`).
		if (this.#createdWithUri && SymbolAdditionUsageWithRange.is(addition.usage)) {
			addition.usage.range = Range.create(0, 0)
		}

		this.#map = this.getMap()
		this.#symbol = this.service.enterMap(
			{
				parentSymbol: this.#parentSymbol,
				map: this.#map,
				category: this.category,
				path: this.path,
				identifier: this.path[this.path.length - 1],
			},
			addition,
			this.#doc,
			this.#currentContributor,
		)
		if (addition.usage?.node) {
			addition.usage.node.symbol = this.#symbol
		}
	}

	private enterInFileSymbol(addition: SymbolAddition): this {
		const raw = this.#lookup(this.category, this.path).symbol
		const originalType = addition.usage?.type ?? 'reference'

		if (this.isLocalSymbol) {
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
			return this
		}

		const usage = Isotope.enterInFileUsage(
			this.service,
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
		return this
	}
}

function delayModeSupport<This extends { readonly service: SymbolService }, Args extends unknown[]>(
	_target: { readonly service: SymbolService },
	_name: string,
	descriptor: TypedPropertyDescriptor<(this: This, ...args: Args) => This>,
): void {
	const method = descriptor.value!
	descriptor.value = function(...args: Args): This {
		this.service.runOrDefer(() => method.apply(this, args))
		return this
	}
}
