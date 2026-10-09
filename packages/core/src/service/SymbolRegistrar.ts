import type { SymbolService } from '../symbol/index.js'

export type SymbolRegistrar = (
	this: void,
	symbols: SymbolService,
	ctx: SymbolRegistrarContext,
) => void

export interface SymbolRegistrarContext {}
