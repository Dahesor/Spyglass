import * as core from '@spyglassmc/core'
import { mockProjectData } from '@spyglassmc/core/test/utils.ts'
import * as mcf from '@spyglassmc/mcfunction'
import { bindDoc, doc as parseDoc } from '@spyglassmc/mcfunction/lib/parser/doc.js'
import { describe, it } from 'node:test'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { uriBinder } from '../../lib/binder/index.js'

const root = 'file:///pack/'
const privateDoc = root + 'data/demo/function/private/doc.mcfunction'
const secondDoc = root + 'data/demo/function/second/doc.mcfunction'
const outside = root + 'data/demo/function/outside.mcfunction'

function setup(category = 'function', ext = '.mcfunction', delayed = false) {
	const project = mockProjectData({ roots: [root], ctx: { loadedVersion: '1.21' } })
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
	const view = (uri: string) => core.SymbolUtil.viewFromContext(raw(), uri)
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
				t.assert.equal(env.raw().definition?.length ?? 0, 0)
				t.assert.equal(env.raw().implementation?.length ?? 0, 0)
				t.assert.equal(env.raw().visibility, 2)
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
				env.project.symbols.clear({ uri: privateDoc, contributor: 'binder' })
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
		env.project.symbols.buildCache()
		env.project.symbols.clear({ uri: privateDoc, contributor: 'binder' })
		t.assert.equal(env.view(privateDoc), undefined)
		t.assert.equal(env.view(secondDoc)?.implementation?.length, 1)
		env.project.symbols.clear({ uri: secondDoc, contributor: 'binder' })
		t.assert.equal(env.view(outside)?.definition?.length, 1)
		t.assert.equal(env.view(outside)?.definition?.[0].uri, env.fileUri)
		t.assert.equal(env.raw().isotopes, undefined)
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
			t.assert.equal(env.raw().definition?.[0].fromFile, undefined)
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
		env.project.symbols.reconcileDocUsages(env.raw())
		t.assert.equal(events, 0)
		env.project.symbols.clear({ uri: outside, contributor: 'binder' })
		t.assert.equal(env.view(outside), undefined)
		t.assert.equal(env.view(privateDoc)?.implementation?.length, 1)
	})
	it('clears and rebinds the source file across every declaration owner', t => {
		const env = setup('structure', '.nbt')
		env.declare()
		env.declare(secondDoc)
		env.bindFile()
		env.project.symbols.clear({ uri: env.fileUri, contributor: 'uri_binder' })
		t.assert.equal(env.raw().isotopes?.length, 2)
		t.assert.equal(env.view(privateDoc)?.implementation?.length ?? 0, 0)
		env.bindFile()
		t.assert.equal(env.view(privateDoc)?.implementation?.length, 1)
		t.assert.equal(env.raw().isotopes?.[1].implementation?.length, 1)
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
		t.assert.equal(env.raw().definition?.length ?? 0, 0)
	})
	it('keeps local headers private and restores their file definition after a cache reload', async t => {
		const env = setup()
		core.binder.registerBinders(env.project.meta)
		const parser = core.file(mcf.entry({ type: 'root', children: {} }, () => () => core.Failure))
		const bind = async (text: string) => {
			const doc = TextDocument.create(env.fileUri, 'mcfunction', 0, text)
			const node = parser(new core.Source(text), core.ParserContext.create(env.project, { doc }))
			env.bindFile()
			env.project.symbols.clear({ uri: env.fileUri, contributor: 'binder' })
			const ctx = core.BinderContext.create(env.project, { doc })
			await env.project.symbols.contributeAsAsync('binder', async () => {
				await env.project.meta.getBinder(node.type)(node, ctx)
			})
			t.assert.deepEqual(ctx.err.errors, [])
			return node
		}
		const header = '#> @local function demo:example Local function'
		await bind(header)
		t.assert.equal(env.project.symbols.getVisibleSymbols('function', outside)['demo:example'], undefined)
		const cached = core.SymbolTable.serialize(env.project.symbols.global)
		env.project.symbols = new core.SymbolUtil(core.SymbolTable.deserialize(cached))
		env.project.symbols.buildCache()
		mcf.initialize(env.project)
		const node = await bind(header)
		t.assert.equal(env.project.symbols.getVisibleSymbols('function', outside)['demo:example'], undefined)
		t.assert.equal(node.locals?.function?.['demo:example']?.implementation?.length, 1)
		await bind('')
		t.assert.equal(env.view(outside)?.definition?.length, 1)
		t.assert.equal(env.view(outside)?.definition?.[0].uri, env.fileUri)
	})
})
