import * as core from '@spyglassmc/core'
import { showWhitespaceGlyph } from '@spyglassmc/core/test/utils.ts'
import { describe, it } from 'node:test'
import { TextDocument } from 'vscode-languageserver-textdocument'
import type * as ls from 'vscode-languageserver/node.js'
import {
	documentSymbolsFromSymbols,
	documentSymbolsFromTable,
	semanticTokens,
} from '../../lib/util/toLS.js'

describe('indexed document symbols', () => {
	for (const hierarchical of [false, true]) {
		it(`matches the full table outline (hierarchical=${hierarchical}) without reading unrelated symbols`, t => {
			const util = new core.SymbolUtil({})
			const doc = TextDocument.create('file:///current.mcfunction', 'mcfunction', 0, 'test')
			util.contributeAs('binder', () => {
				util.query(doc, 'function', 'current').enter({ usage: { type: 'definition' } })
				util.query(doc, 'function', 'current', 'child').enter({
					usage: { type: 'declaration' },
				})
				util.query(doc, 'function', 'referenceOnly').enter({ usage: { type: 'reference' } })
				for (let i = 0; i < 2000; i++) {
					util.query(`file:///other${i}`, 'function', `other${i}`).enter({
						usage: { type: 'definition' },
					})
				}
			})
			const expected = documentSymbolsFromTable(util.global, doc, hierarchical)
			const unrelated = util.global.function!['other1999']
			Object.defineProperty(unrelated, 'facets', {
				get() {
					throw new Error('Unrelated symbol visited')
				},
			})
			const actual = documentSymbolsFromSymbols(
				core.GlobalSymbol.getSymbolsInFile(util, doc.uri).filter(symbol =>
					!symbol.parentSymbol
				),
				doc,
				hierarchical,
			)
			t.assert.deepEqual(actual, expected)
			t.assert.deepEqual(actual.map(symbol => symbol.name), ['current'])
		})
	}
})

/**
 * The result of decoding a semantic token from an integer list.
 * The VSCode API documentation details what the integer list represents here:
 * https://code.visualstudio.com/api/references/vscode-api#DocumentSemanticTokensProvider.provideDocumentSemanticTokens
 */
interface DecodedSemanticToken {
	deltaLine: number
	deltaStartChar: number
	length: number
	tokenType: number
	tokenModifiers: number
}
const decodeSemanticTokens = (tokens: ls.SemanticTokens['data']): DecodedSemanticToken[] => {
	if (tokens.length % 5 !== 0) {
		throw new Error('Array of semantic tokens must be divisible by 5')
	}
	const decodedTokens = []
	for (let i = 0; i < tokens.length; i += 5) {
		const decodedToken = {
			deltaLine: tokens[i],
			deltaStartChar: tokens[i + 1],
			length: tokens[i + 2],
			tokenType: tokens[i + 3],
			tokenModifiers: tokens[i + 4],
		}
		decodedTokens.push(decodedToken)
	}
	return decodedTokens
}

describe('semanticTokens', () => {
	const tokens: core.ColorToken[] = [{ range: { start: 0, end: 100 }, type: 'comment' }]
	const suites: { content: string }[] = [{ content: 'foo' }, { content: 'foo\nbar' }, {
		content: 'foo\nbar\nqux',
	}]
	for (const hasMultilineTokenSupport of [true, false]) {
		for (const { content } of suites) {
			const doc = TextDocument.create('file:///test', '', 0, content)
			const multilineStr = `${
				hasMultilineTokenSupport ? 'with' : 'without'
			} multiline token support`
			const itTitle = `Tokenize "${showWhitespaceGlyph(content)}" ${multilineStr}`
			it(itTitle, (t) => {
				const { data } = semanticTokens(tokens, doc, hasMultilineTokenSupport)
				t.assert.snapshot(decodeSemanticTokens(data))
			})
		}
	}
})
