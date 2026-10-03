import * as core from '@spyglassmc/core'
import type { DocAccess, DocDirectiveNode, DocNode } from '../../node/index.js'
import { DefaultDocDirective, registerDocDirective } from '../doc.js'

export function registerDocDirectives(meta: core.MetaRegistry): void {
	registerDocDirective(meta, new PublicDocDirective())
	registerDocDirective(meta, new PrivateDocDirective())
	registerDocDirective(meta, new LocalDocDirective())
}

export class PublicDocDirective extends DefaultDocDirective {
	override readonly identifier = 'public'
	override readonly isAccessModifier = true
	override modifyAccess(
		_directive: core.DeepReadonly<DocDirectiveNode>,
		_node: DocNode,
	): DocAccess {
		return { visibility: core.SymbolVisibility.Public }
	}
}

export class PrivateDocDirective extends DefaultDocDirective {
	override readonly identifier = 'private'
	override readonly isAccessModifier = true
	override modifyAccess(
		_directive: core.DeepReadonly<DocDirectiveNode>,
		_node: DocNode,
		ctx: core.BinderContext,
	): DocAccess {
		const folder = ctx.doc.uri.slice(0, ctx.doc.uri.lastIndexOf('/') + 1)
		const escapedFolder = folder.replace(/[\\*?\[\]{}()!+@]/g, '\\$&')
		return {
			visibility: core.SymbolVisibility.Restricted,
			isotope: { scope: core.SymbolIsotopeScope.Private, visibleWithin: [`${escapedFolder}**`] },
		}
	}
}

export class LocalDocDirective extends DefaultDocDirective {
	override readonly identifier = 'local'
	override readonly isAccessModifier = true
	override modifyAccess(
		_directive: core.DeepReadonly<DocDirectiveNode>,
		_node: DocNode,
	): DocAccess {
		return { visibility: core.SymbolVisibility.File }
	}
}
