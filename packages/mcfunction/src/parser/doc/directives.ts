import * as core from '@spyglassmc/core'
import type { DocAccess, DocDirectiveNode, DocNode } from '../../node/index.js'
import { DefaultDocDirective, registerDocDirective } from '../doc.js'

export function registerDocDirectives(meta: core.MetaRegistry): void {
	registerDocDirective(meta, new PublicDocDirective())
	registerDocDirective(meta, new InternalDocDirective())
	registerDocDirective(meta, new ProtectedDocDirective())
	registerDocDirective(meta, new PrivateDocDirective())
	registerDocDirective(meta, new LocalDocDirective())
	registerDocDirective(meta, new UserDocDirective())
	registerDocDirective(meta, new ChatOnlyDocDirective())
	registerDocDirective(meta, new DeprecatedDocDirective())
	registerDocDirective(meta, new OverrideDocDirective())
	registerDocDirective(meta, new ReturnsDocDirective())
	registerDocDirective(meta, new ContextDocDirective())
	registerDocDirective(meta, new ReadsDocDirective())
	registerDocDirective(meta, new WritesDocDirective())
	registerDocDirective(meta, new InputDocDirective())
}

export class PublicDocDirective extends DefaultDocDirective {
	override readonly identifier = 'public'
	override readonly isAccessModifier = true
	override modifyAccess(
		_directive: core.DeepReadonly<DocDirectiveNode>,
		_node: DocNode,
	): DocAccess {
		return { visibility: core.SymbolIsotopeScope.Global }
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
			visibility: core.SymbolIsotopeScope.Private,
			visibleWithin: [`${escapedFolder}**`],
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
		return { visibility: core.SymbolIsotopeScope.Local }
	}
}

export class UserDocDirective extends DefaultDocDirective {
	override readonly identifier = 'user'
	// TODO
}

export class ChatOnlyDocDirective extends DefaultDocDirective {
	override readonly identifier = 'chatonly'
	override readonly isCommon: boolean = false
	// TODO
}

export class ProtectedDocDirective extends DefaultDocDirective {
	override readonly identifier = 'protected'
	override readonly isAccessModifier: boolean = true
	// TODO
}

export class InternalDocDirective extends DefaultDocDirective {
	override readonly identifier = 'internal'
	override readonly isAccessModifier: boolean = true
	override modifyAccess(
		_directive: core.DeepReadonly<DocDirectiveNode>,
		_node: DocNode,
	): DocAccess {
		return { visibility: core.SymbolIsotopeScope.Project }
	}
}

export class DeprecatedDocDirective extends DefaultDocDirective {
	override readonly identifier = 'deprecated'
	// TODO
}

export class OverrideDocDirective extends DefaultDocDirective {
	override readonly identifier = 'override'
	// TODO
}

export class ReturnsDocDirective extends DefaultDocDirective {
	override readonly identifier = 'returns'
	override readonly isCommon: boolean = false
	// TODO
}

export class ContextDocDirective extends DefaultDocDirective {
	override readonly identifier = 'context'
	override readonly isCommon: boolean = false
	// TODO
}

export class ReadsDocDirective extends DefaultDocDirective {
	override readonly identifier = 'reads'
	override readonly isCommon: boolean = false
	// TODO
}

export class WritesDocDirective extends DefaultDocDirective {
	override readonly identifier = 'writes'
	override readonly isCommon: boolean = false
	// TODO
}

export class InputDocDirective extends DefaultDocDirective {
	override readonly identifier = 'input'
	override readonly isCommon: boolean = false
	// TODO
}
