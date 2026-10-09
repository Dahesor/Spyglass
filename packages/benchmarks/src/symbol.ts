import { SymbolService, SymbolStorage } from '@spyglassmc/core'
import type { BenchContext } from './index.js'

export function register(bench: BenchContext): void {
	const service = new SymbolService(new SymbolStorage())
	for (let i = 0; i < 20_000; i++) {
		service.query(`file:///symbol${i}`, 'test', `symbol${i}`).enter({
			usage: { type: 'definition' },
		})
	}
	let index = 0
	const branches: SymbolService[] = []
	bench.add('symbol lookup in 20000 symbols', () => {
		const id = index++ % 20_000
		service.query(`file:///symbol${id}`, 'test', `symbol${id}`).symbol
	})
	bench.add('symbol clone with shared storage', () => {
		// Retain branches so the optimizer cannot eliminate the allocation.
		branches[index++ % 128] = service.cloneDelayed()
	})
	bench.add('symbol indexed file cleanup in 20000 symbols', () => {
		service.query('file:///temporary', 'test', 'temporary').enter({
			usage: { type: 'definition' },
		})
		service.clear({ uri: 'file:///temporary' })
	})
}
