import * as core from '@spyglassmc/core'
import type { DocDirectiveNode, DocNode } from '../../node/index.js'
import { DefaultDocDirective, registerDocDirective } from '../doc.js'

export class PublicDocDirective extends DefaultDocDirective {
	override identifier = 'public'
	override isAccessModifier = true
}

export class PrivateDocDirective extends DefaultDocDirective {
	override identifier = 'private'
	override isAccessModifier = true
	override modifyAccess(_directive: core.DeepReadonly<DocDirectiveNode>, node: DocNode): void {
		node.visibility = core.SymbolVisibility.File
	}
}

export function registerDocDirectives(meta: core.MetaRegistry): void {
	registerDocDirective(meta, new PublicDocDirective())
	registerDocDirective(meta, new PrivateDocDirective())
}
