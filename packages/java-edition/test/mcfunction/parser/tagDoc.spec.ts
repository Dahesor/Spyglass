import * as core from '@spyglassmc/core'
import { mockProjectData } from '@spyglassmc/core/test/utils.ts'
import * as mcf from '@spyglassmc/mcfunction'
import { bindDoc, doc as parseDoc } from '@spyglassmc/mcfunction/lib/parser/doc.js'
import { it } from 'node:test'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { argument } from '../../../lib/mcfunction/parser/argument.js'
import { getPatch } from '../../../lib/mcfunction/tree/patch.js'

for (const docFirst of [false, true]) {
	it(`keeps home tag completion outside a private doc folder (doc first: ${docFirst})`, t => {
		const project = mockProjectData()
		mcf.initialize(project)
		const root = 'file:///pack/data/test/function/'
		const home = TextDocument.create(
			root + 'home.mcfunction',
			'mcfunction',
			0,
			'tag @s add myTag',
		)
		const inner = TextDocument.create(
			root + 'folder/inner.mcfunction',
			'mcfunction',
			0,
			'\n#>@private tag myTag balabala',
		)
		const tagTree = getPatch('1.21').children!['tag']!.children!['targets']!.children!
		const add = tagTree['add']!.children!['name']!
		const remove = tagTree['remove']!.children!['name']!
		const bindCommand = (doc: TextDocument, tree = add) => {
			if (!('parser' in tree) || !tree.parser) {
				throw new Error('Expected tag argument patch')
			}
			const parser = argument({
				type: 'argument',
				parser: tree.parser,
				properties: tree.properties,
			}, [])!
			const node = parser(new core.Source('myTag'), core.ParserContext.create(project, { doc }))
			if (node === core.Failure || !core.SymbolNode.is(node)) {
				throw new Error('Expected a tag symbol')
			}
			core.binder.symbol(node, core.BinderContext.create(project, { doc }))
			return node
		}
		const declaration = () => {
			const source = new core.Source(inner.getText())
			source.skip()
			const node = parseDoc(source, core.ParserContext.create(project, { doc: inner }))
			bindDoc(node, core.BinderContext.create(project, { doc: inner }))
		}
		if (docFirst) {
			declaration()
		}
		const homeNode = bindCommand(home)
		if (!docFirst) {
			declaration()
		}
		bindCommand(inner)
		bindCommand(home, remove)
		const raw = homeNode.symbol!
		const outside = core.SymbolUtil.viewFromContext(raw, home.uri)!
		t.assert.equal(homeNode.options.usageType, 'definition')
		t.assert.equal(outside.definition?.[0].uri, home.uri)
		t.assert.equal(outside.definition?.length, 1)
		t.assert.equal(outside.reference?.length, 1)
		t.assert.equal(core.SymbolUtil.viewFromContext(raw, inner.uri)?.implementation?.length, 1)
		const completions = core.completer.symbol(
			core.SymbolNode.mock(0, { category: 'tag' }),
			core.CompleterContext.create(project, { doc: home, offset: 0 }),
		)
		t.assert.equal(completions.some(item => item.label === 'myTag'), true)
	})
}
