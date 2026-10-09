import { SymbolFormatter, SymbolUtil, UriBinderContext } from '@spyglassmc/core'
import { mockProjectData } from '@spyglassmc/core/test/utils.ts'
import { uriBinder } from '@spyglassmc/mcdoc/lib/uri_processors.js'
import { describe, it } from 'node:test'

describe('mcdoc uriBinder()', () => {
	it('keeps module definitions independent of scoped doc declarations', t => {
		const project = mockProjectData({ roots: ['file:///root/'] })
		const uri = 'file:///root/example.mcdoc'
		const docUri = 'file:///root/private/doc.mcfunction'
		const ctx = UriBinderContext.create(project)
		ctx.symbols.contributeAs('uri_binder', () => uriBinder([uri], ctx))
		ctx.symbols.contributeAs('binder', () => {
			ctx.symbols.query(docUri, 'mcdoc', '::example').enterIsotope('doc', {
				data: { scope: 0, visibleWithin: [{ glob: '**/private/**' }], source: 0 },
				usage: { type: 'declaration', fromDocDeclaration: true },
			})
		})
		const symbol = project.symbolStorage.global.mcdoc!['::example']
		t.assert.equal(symbol.subcategory, 'module')
		t.assert.equal(SymbolUtil.viewFromContext(symbol, uri)?.definition?.[0].uri, uri)
		t.assert.equal(symbol.facets?.global?.definition?.[0].fromFile, undefined)
		t.assert.equal(symbol.facets?.global?.definition?.[0].originalUsageType, undefined)
		t.assert.equal(symbol.facets?.isotopes?.[0].implementation?.length ?? 0, 0)
		ctx.symbols.clear({ uri: docUri })
		t.assert.equal(symbol.facets?.global?.definition?.length, 1)
		t.assert.equal(symbol.facets?.global?.definition?.[0].uri, uri)
	})
	const suites: { uris: string[] }[] = [
		{
			uris: [
				'file:///a.mcdoc',
				'file:///root/minecraft/foo.mcdoc',
				'file:///root/minecraft/bar.mcdoc',
				'file:///root/minecraft/qux.mcfunction',
			],
		},
		{
			uris: [
				'file:///root/mod.mcdoc',
				'file:///root/minecraft/mod.mcdoc',
				'file:///root/minecraft/foo/mod.mcdoc',
			],
		},
		{
			uris: [
				'file:///root/qux.mcdoc',
				'file:///root/mcdoc/foo.mcdoc',
				'file:///root/mcdoc/minecraft/bar.mcdoc',
			],
		},
		{ uris: ['file:///root/mcdoc/foo.mcdoc', 'file:///root/mcdoc/minecraft/bar.mcdoc'] },
		{
			uris: [
				'file:///root/mcdoc/mod.mcdoc',
				'file:///root/mcdoc/foo.mcdoc',
				'file:///root/mcdoc/minecraft/bar.mcdoc',
			],
		},
	]
	for (const { uris } of suites) {
		it(
			`Bind ${
				JSON.stringify(
					uris.map((u) => u.startsWith('file:///root/') ? u.slice('file:///root/'.length) : u),
				)
			}`,
			(t) => {
				const ctx = UriBinderContext.create(mockProjectData({ roots: ['file:///root/'] }))
				uriBinder(uris, ctx)
				t.assert.snapshot(SymbolFormatter.stringifySymbolTable(ctx.symbols.storage.global))
			},
		)
	}
})
