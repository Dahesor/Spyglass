import type * as core from '@spyglassmc/core'
import { DefaultDocDirective, registerDocDirective } from '../doc.js'

export class PublicDocDirective extends DefaultDocDirective {
	override identifier = 'public'
	override isAccessModifier = true
}

export function registerDocDirectives(meta: core.MetaRegistry): void {
	registerDocDirective(meta, new PublicDocDirective())
}
