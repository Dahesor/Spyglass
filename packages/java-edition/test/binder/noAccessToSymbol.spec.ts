/* eslint-disable no-restricted-syntax */
import * as core from '@spyglassmc/core'
import { mockProjectData } from '@spyglassmc/core/test/utils.ts'
import * as mcf from '@spyglassmc/mcfunction'
import { bindDoc, doc as parseDoc } from '@spyglassmc/mcfunction/lib/parser/doc.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { registerUriBuilders, uriBinder } from '../../lib/binder/index.js'

const root = 'file:///pack/'
const privateDoc = root + 'data/demo/function/private/doc.mcfunction'
const outside = root + 'data/demo/function/outside.mcfunction'

function setup(category = 'function', extension = '.mcfunction', withFile = true) {
	const project = mockProjectData({
		roots: [root],
		ctx: { loadedVersion: '1.21' },
		config: core.ConfigService.merge(core.VanillaConfig),
	})
	mcf.initialize(project)
	registerUriBuilders(project.meta)
	const fileUri = root + `data/demo/${category}/example${extension}`
	if (withFile) {
		const ctx = core.UriBinderContext.create(project)
		ctx.symbols.contributeAs('uri_binder', () => uriBinder([fileUri], ctx))
	}
	const declare = (uri = privateDoc, modifier = '@private') => {
		const text = `\n#> ${modifier} ${category} demo:example Documentation`
		const doc = TextDocument.create(uri, 'mcfunction', 0, text)
		const source = new core.Source(text)
		source.skip()
		const parserCtx = core.ParserContext.create(project, { doc })
		const node = parseDoc(source, parserCtx)
		const binderCtx = core.BinderContext.create(project, { doc })
		binderCtx.symbols.contributeAs('binder', () => bindDoc(node, binderCtx))
		if (parserCtx.err.errors.length || binderCtx.err.errors.length) {
			throw new Error('Unexpected doc declaration errors')
		}
	}
	declare()
	const lint = (uri = outside, name = 'demo:example') => {
		const doc = TextDocument.create(uri, 'mcfunction', 0, name)
		const node = core.ResourceLocationNode.mock(core.Range.create(0, name.length), {
			category: 'function',
			usageType: 'reference',
		})
		node.namespace = name.split(':')[0]
		node.path = name.split(':')[1].split('/')
		// The test category may be another file resource, with the same binding and linting path.
		const symbols = new core.SymbolService(project.symbolStorage)
		symbols.contributeAs('binder', () => {
			symbols.query({ doc, node }, category, name).enter({
				usage: { type: 'reference', node },
			}, core.SymbolEnterType.InFileSymbol)
		})
		const errors: core.LanguageError[] = []
		for (const ruleName of ['undeclaredSymbol', 'noAccessToSymbol'] as const) {
			const value = core.LinterConfigValue.destruct(
				ruleName === 'noAccessToSymbol' ? true : project.config.lint.undeclaredSymbol,
			)
			if (!value) {
				continue
			}
			const registration = project.meta.getLinter(ruleName)
			if (
				!registration.configValidator(ruleName, value.ruleValue, project.logger)
				|| !registration.nodePredicate(node)
			) {
				continue
			}
			const ctx = core.LinterContext.create(project, {
				doc,
				ruleName,
				ruleValue: value.ruleValue,
				err: new core.LinterErrorReporter(ruleName, value.ruleSeverity),
			})
			ctx.symbols.contributeAs(
				'checker',
				() => registration.linter(core.StateProxy.create(node), ctx),
			)
			errors.push(...ctx.err.errors)
		}
		return errors
	}
	return {
		project,
		declare,
		lint,
		raw: () => project.symbolStorage.global[category]!['demo:example'],
	}
}

describe('noAccessToSymbol', () => {
	for (
		const [category, extension] of [['function', '.mcfunction'], ['predicate', '.json'], [
			'structure',
			'.nbt',
		]]
	) {
		it(`reports inaccessible ${extension} file symbols without an undeclared-file action`, t => {
			const env = setup(category, extension)
			const errors = env.lint()
			t.assert.equal(errors.length, 1)
			assert.ok(errors[0].message.includes('noAccessToSymbol'))
			t.assert.equal(errors[0].severity, 2)
			t.assert.equal(errors[0].info?.codeAction, undefined)
			t.assert.equal(env.raw().facets?.global?.isotopes.length ?? 0, 0)
			t.assert.deepEqual(env.lint(root + 'data/demo/function/private/sub/use.mcfunction'), [])
		})
	}
	it('keeps undeclaredSymbol for names with no file definition', t => {
		const env = setup()
		const errors = env.lint(outside, 'demo:missing')
		t.assert.equal(errors.length, 1)
		assert.ok(errors[0].message.includes('undeclaredSymbol'))
		t.assert.equal(errors[0].info?.codeAction?.changes?.[0].type, 'create')
	})
	it('keeps undeclaredSymbol for a private doc declaration without a source file', t => {
		const env = setup('function', '.mcfunction', false)
		assert.ok(env.lint()[0].message.includes('undeclaredSymbol'))
	})
	it('resolves aliases before checking access', t => {
		const env = setup()
		new core.SymbolService(env.project.symbolStorage).query(outside, 'function', 'demo:alias')
			.enter({
				data: { relations: { aliasOf: { category: 'function', path: ['demo:example'] } } },
			})
		const errors = env.lint(outside, 'demo:alias')
		t.assert.equal(errors.length, 1)
		assert.ok(errors[0].message.includes('noAccessToSymbol'))
		assert.ok(errors[0].message.includes('demo:example'))
	})
	for (const disabled of [null, false, ['error', false] as const, 'error']) {
		it(`ignores legacy access diagnostic configuration (${disabled})`, t => {
			const env = setup()
			env.project.config = core.ConfigService.merge(env.project.config, {
				lint: { noAccessToSymbol: disabled },
			})
			env.project.config.lint.undeclaredSymbol = { declare: 'public', report: 'warning' }
			const errors = env.lint()
			t.assert.equal(errors.length, 1)
			assert.ok(errors[0].message.includes('noAccessToSymbol'))
			t.assert.equal(errors[0].severity, 2)
			t.assert.equal(env.raw().facets?.global?.isotopes.length ?? 0, 0)
			t.assert.equal(env.raw().facets?.global?.declaration?.length ?? 0, 0)
			t.assert.equal(core.SymbolUtil.viewFromContext(env.raw(), outside), undefined)
		})
	}
	it('always reports access violations when undeclaredSymbol is disabled', t => {
		const env = setup()
		env.project.config.lint.undeclaredSymbol = null
		const errors = env.lint()
		t.assert.equal(errors.length, 1)
		assert.ok(errors[0].message.includes('noAccessToSymbol'))
		t.assert.equal(errors[0].severity, 2)
	})
	it('allows either private scope and a public base', t => {
		const env = setup()
		const second = root + 'data/demo/function/second/doc.mcfunction'
		env.declare(second)
		t.assert.deepEqual(env.lint(second), [])
		t.assert.deepEqual(env.lint(privateDoc), [])
		t.assert.equal(env.lint().length, 1)
		env.declare(outside, '@public')
		t.assert.deepEqual(env.lint(), [])
	})
	it('restores access after the private doc is removed', t => {
		const env = setup()
		t.assert.equal(env.lint().length, 1)
		new core.SymbolService(env.project.symbolStorage).clear({
			uri: privateDoc,
			contributor: 'binder',
		})
		t.assert.deepEqual(env.lint(), [])
		t.assert.equal(env.raw().facets?.global?.definition?.length, 1)
	})
	it('recognizes inaccessible file symbols after a symbol cache reload', t => {
		const env = setup()
		env.project.symbolStorage = new core.SymbolStorage(core.SymbolTable.deserialize(
			core.SymbolTable.serialize(env.project.symbolStorage.global),
		))
		env.project.symbolStorage.rebuildIndex()
		const errors = env.lint()
		t.assert.equal(errors.length, 1)
		assert.ok(errors[0].message.includes('noAccessToSymbol'))
	})
})
