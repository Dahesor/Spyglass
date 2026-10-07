import { GlobalSymbol } from '@spyglassmc/core'
import * as core from '@spyglassmc/core'
import { mockProjectData } from '@spyglassmc/core/test/utils.ts'
import * as mcf from '@spyglassmc/mcfunction'
import { bindDoc, doc as parseDoc } from '@spyglassmc/mcfunction/lib/parser/doc.js'
import { describe, it } from 'node:test'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { registerResourceLocationResolver, uriBinder } from '../../lib/binder/index.js'

const root = 'file:///pack/'
const privateDoc = root + 'data/demo/function/private/doc.mcfunction'
const secondDoc = root + 'data/demo/function/second/doc.mcfunction'
const outside = root + 'data/demo/function/outside.mcfunction'

function setup(category = 'function', ext = '.mcfunction', delayed = false) {
	const project = mockProjectData({ roots: [root], ctx: { loadedVersion: '1.21' } })
	registerResourceLocationResolver(project.meta)
	mcf.initialize(project)
	if (delayed) {
		project.symbols = project.symbols.clone()
	}
	const fileUri = root + `data/demo/${category}/example${ext}`
	const declare = (uri = privateDoc, modifier = '@private', header = false) => {
		const text = `${header ? '' : '\n'}#> ${modifier} ${category} demo:example Documentation`
		const doc = TextDocument.create(uri, 'mcfunction', 0, text)
		const source = new core.Source(text)
		if (!header) {
			source.skip()
		}
		const parserCtx = core.ParserContext.create(project, { doc })
		const node = parseDoc(source, parserCtx)
		const binderCtx = core.BinderContext.create(project, { doc })
		project.symbols.contributeAs('binder', () => bindDoc(node, binderCtx))
		return [...parserCtx.err.errors, ...binderCtx.err.errors]
	}
	const bindFile = () =>
		project.symbols.contributeAs(
			'uri_binder',
			() => uriBinder([fileUri], core.UriBinderContext.create(project)),
		)
	const raw = () => project.symbols.global[category]!['demo:example']
	const view = (uri: string) =>
		core.SymbolUtil.viewFromContext(raw(), uri, project.symbols.resolveResourceLocation)
	return { project, fileUri, declare, bindFile, raw, view }
}

describe('file-origin definitions and doc declarations', () => {
	for (
		const [category, ext] of [
			['function', '.mcfunction'],
			['predicate', '.json'],
			['loot_table', '.json'],
			['structure', '.nbt'],
		]
	) {
		for (const docFirst of [false, true]) {
			it(`${category} ${ext} file implements a doc outside its URI scope (doc first: ${docFirst})`, t => {
				const env = setup(category, ext)
				if (docFirst) {
					t.assert.deepEqual(env.declare(), [])
				}
				env.bindFile()
				if (!docFirst) {
					t.assert.equal(env.view(outside)?.definition?.[0].uri, env.fileUri)
					t.assert.deepEqual(env.declare(), [])
				}
				t.assert.equal(env.raw().facets?.global?.definition?.length ?? 0, 0)
				t.assert.equal(env.raw().facets?.global?.implementation?.length ?? 0, 0)
				t.assert.equal(env.raw().facets?.global?.isotopes.length ?? 0, 0)
				t.assert.equal(env.view(outside), undefined)
				const scoped = env.view(privateDoc)!
				t.assert.equal(scoped.declaration?.length, 1)
				t.assert.equal(scoped.implementation?.length, 1)
				t.assert.equal(scoped.implementation?.[0].uri, env.fileUri)
				t.assert.equal(scoped.implementation?.[0].contributor, 'uri_binder')
				t.assert.equal(scoped.implementation?.[0].fromFile, true)
				t.assert.equal(scoped.implementation?.[0].range?.start, 0)
			})
		}
	}
	for (const modifier of ['@public', '']) {
		for (const docFirst of [false, true]) {
			it(`public doc makes a file implementation (${modifier}, doc first: ${docFirst})`, t => {
				const env = setup()
				if (docFirst) {
					env.declare(privateDoc, modifier)
				}
				env.bindFile()
				if (!docFirst) {
					env.declare(privateDoc, modifier)
				}
				t.assert.equal(env.view(outside)?.definition?.length ?? 0, 0)
				t.assert.equal(env.view(outside)?.implementation?.[0].uri, env.fileUri)
				GlobalSymbol.clear(env.project.symbols, { uri: privateDoc, contributor: 'binder' })
				t.assert.equal(env.view(outside)?.definition?.length, 1)
				t.assert.equal(env.view(outside)?.implementation?.length ?? 0, 0)
			})
		}
	}
	it('restores one file definition after multiple private docs are removed following cache reload', t => {
		const env = setup()
		env.bindFile()
		env.declare()
		env.declare(secondDoc)
		t.assert.equal(env.view(privateDoc)?.implementation?.length, 1)
		t.assert.equal(env.view(secondDoc)?.implementation?.length, 1)
		env.project.symbols = new core.SymbolUtil(core.SymbolTable.deserialize(
			core.SymbolTable.serialize(env.project.symbols.global),
		))
		GlobalSymbol.buildCache(env.project.symbols)
		GlobalSymbol.clear(env.project.symbols, { uri: privateDoc, contributor: 'binder' })
		t.assert.equal(env.view(privateDoc), undefined)
		t.assert.equal(env.view(secondDoc)?.implementation?.length, 1)
		GlobalSymbol.clear(env.project.symbols, { uri: secondDoc, contributor: 'binder' })
		t.assert.equal(env.view(outside)?.definition?.length, 1)
		t.assert.equal(env.view(outside)?.definition?.[0].uri, env.fileUri)
		t.assert.equal(env.raw().facets?.isotopes?.length ?? 0, 0)
	})
	for (const ext of ['.mcfunction', '.nbt']) {
		it(`keeps unmarked URI binder definitions separate from file definitions (${ext})`, t => {
			const category = ext === '.nbt' ? 'structure' : 'function'
			const env = setup(category, ext)
			env.project.symbols.contributeAs('uri_binder', () => {
				env.project.symbols.query(env.fileUri, category, 'demo:example').enter({
					usage: { type: 'definition' },
				})
			})
			t.assert.equal(env.raw().facets?.global?.definition?.[0].fromFile, undefined)
			env.declare()
			t.assert.equal(env.view(outside)?.definition?.[0].uri, env.fileUri)
			t.assert.equal(env.view(privateDoc)?.declaration?.length, 1)
			t.assert.equal(env.view(privateDoc)?.implementation?.length ?? 0, 0)
		})
	}
	it('keeps file implementations on both public and private declarations without repeated events', t => {
		const env = setup()
		env.bindFile()
		env.declare()
		env.declare(outside, '@public')
		t.assert.equal(env.view(outside)?.implementation?.length, 1)
		t.assert.equal(env.view(privateDoc)?.implementation?.length, 1)
		let events = 0
		env.project.symbols.on('symbolLocationCreated', () => events++)
		env.project.symbols.on('symbolLocationRemoved', () => events++)
		core.Isotope.reconcileDocUsages(env.project.symbols, env.raw())
		t.assert.equal(events, 0)
		GlobalSymbol.clear(env.project.symbols, { uri: outside, contributor: 'binder' })
		t.assert.equal(env.view(outside), undefined)
		t.assert.equal(env.view(privateDoc)?.implementation?.length, 1)
	})
	it('clears and rebinds the source file across every declaration owner', t => {
		const env = setup('structure', '.nbt')
		env.declare()
		env.declare(secondDoc)
		env.bindFile()
		GlobalSymbol.clear(env.project.symbols, { uri: env.fileUri, contributor: 'uri_binder' })
		t.assert.equal(env.raw().facets?.isotopes?.length, 2)
		t.assert.equal(env.view(privateDoc)?.implementation?.length ?? 0, 0)
		env.bindFile()
		t.assert.equal(env.view(privateDoc)?.implementation?.length, 1)
		t.assert.equal(env.raw().facets?.isotopes?.[1].implementation?.length, 1)
	})
	for (const docFirst of [false, true]) {
		it(`handles deferred file binding (doc first: ${docFirst})`, t => {
			const env = setup('function', '.mcfunction', true)
			if (docFirst) {
				env.declare()
			}
			env.bindFile()
			if (!docFirst) {
				env.declare()
			}
			t.assert.equal(env.project.symbols.global.function, undefined)
			env.project.symbols.applyDelayedEdits()
			t.assert.equal(env.view(outside), undefined)
			t.assert.equal(env.view(privateDoc)?.implementation?.[0].uri, env.fileUri)
		})
	}
	it('keeps definitions from file contents dependent on the command URI', t => {
		const env = setup()
		env.declare()
		env.bindFile()
		env.project.symbols.contributeAs('binder', () => {
			for (const uri of [privateDoc, outside]) {
				env.project.symbols.query(uri, 'function', 'demo:example').enterCommand({
					usage: { type: 'definition' },
				})
			}
		})
		t.assert.equal(env.view(outside)?.definition?.length, 1)
		t.assert.equal(env.view(outside)?.definition?.[0].uri, outside)
		t.assert.equal(env.view(privateDoc)?.implementation?.length, 2)
		t.assert.equal(
			env.view(privateDoc)?.implementation?.filter(location => location.fromFile).length,
			1,
		)
	})
	it('binds a function header after another private doc has already claimed the file definition', t => {
		const env = setup()
		env.bindFile()
		env.declare()
		t.assert.deepEqual(env.declare(env.fileUri, '@private', true), [])
		t.assert.equal(env.view(env.fileUri)?.implementation?.[0].uri, env.fileUri)
		t.assert.equal(env.raw().facets?.global?.definition?.length ?? 0, 0)
	})
	it('keeps local headers private and restores their file definition after a cache reload', async t => {
		const env = setup()
		core.binder.registerBinders(env.project.meta)
		const parser = core.file(mcf.entry({ type: 'root', children: {} }, () => () => core.Failure))
		const bind = async (text: string, restoreFromUriBinder = true) => {
			const doc = TextDocument.create(env.fileUri, 'mcfunction', 0, text)
			const node = parser(new core.Source(text), core.ParserContext.create(env.project, { doc }))
			if (restoreFromUriBinder) {
				env.bindFile()
			}
			GlobalSymbol.clear(env.project.symbols, { uri: env.fileUri, contributor: 'binder' })
			const ctx = core.BinderContext.create(env.project, { doc })
			let restoredDefinitions = 0
			const listener = ({ location }: core.SymbolLocationEvent) => {
				if (location.contributor === 'uri_binder' && location.fromFile) {
					restoredDefinitions++
				}
			}
			const controller = new AbortController()
			env.project.symbols.on('symbolLocationCreated', listener, { signal: controller.signal })
			await env.project.symbols.contributeAsAsync('binder', async () => {
				await env.project.meta.getBinder(node.type)(core.StateProxy.create(node), ctx)
			})
			controller.abort()
			t.assert.equal(restoredDefinitions, restoreFromUriBinder ? 0 : 1)
			t.assert.deepEqual(ctx.err.errors, [])
			return node
		}
		const header = '#> @local function demo:example Local function'
		await bind(header)
		const rebound = await bind(header)
		t.assert.equal(
			core.SymbolUtil.viewFromContext(rebound.locals?.function?.['demo:example'], env.fileUri)
				?.declaration?.length,
			1,
		)
		t.assert.equal(
			GlobalSymbol.getVisibleSymbols(env.project.symbols, 'function', outside)['demo:example'],
			undefined,
		)
		const cached = core.SymbolTable.serialize(env.project.symbols.global)
		env.project.symbols = new core.SymbolUtil(core.SymbolTable.deserialize(cached))
		GlobalSymbol.buildCache(env.project.symbols)
		mcf.initialize(env.project)
		const node = await bind(header)
		t.assert.equal(
			GlobalSymbol.getVisibleSymbols(env.project.symbols, 'function', outside)['demo:example'],
			undefined,
		)
		const local = node.locals?.function?.['demo:example']
		t.assert.equal(core.LocalSymbol.is(local), true)
		if (!core.LocalSymbol.is(local)) {
			throw new Error('Expected local symbol')
		}
		t.assert.equal(local.facets, undefined)
		t.assert.equal(local.implementation?.length, 1)
		await bind('')
		t.assert.equal(env.view(outside)?.definition?.length, 1)
		t.assert.equal(env.view(outside)?.definition?.[0].uri, env.fileUri)
		await bind(header)
		await bind('', false)
		t.assert.equal(env.view(outside)?.definition?.length, 1)
	})
})

it('binds protected documentation using the registered resource resolver', t => {
	const env = setup()
	env.bindFile()
	t.assert.deepEqual(env.declare(privateDoc, '@protected'), [])
	t.assert.deepEqual(env.raw().facets?.isotopes?.[0].visibleWithin, [{ namespace: 'demo' }])
	t.assert.equal(env.view(outside)?.desc, ' Documentation')
	t.assert.equal(env.view(outside.replace('/demo/', '/other/')), undefined)
	const restored = core.SymbolTable.deserialize(
		core.SymbolTable.serialize(env.project.symbols.global),
	)
	const symbols = new core.SymbolUtil(
		restored,
		undefined,
		false,
		env.project.symbols.resolveResourceLocation,
	)
	t.assert.equal(symbols.query(outside, 'function', 'demo:example').symbol?.desc, ' Documentation')
	t.assert.equal(
		symbols.query(outside.replace('/demo/', '/other/'), 'function', 'demo:example').symbol,
		undefined,
	)
})
