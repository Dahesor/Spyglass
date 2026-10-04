import { describe, it } from 'node:test'
import { TextDocument } from 'vscode-languageserver-textdocument'
import type { FileNode, Symbol, SymbolLocation, SymbolUsageType } from '../../lib/index.js'
import { AstNode, Logger, Range, Service, SymbolNode } from '../../lib/index.js'
import { mockProjectData } from '../utils.ts'

const uri = 'file:///pack/private/use.mcfunction'
const doc = TextDocument.create(uri, 'mcfunction', 0, 'name')

function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
	const project = mockProjectData({ projectRoots: [], logger: Logger.noop() })
	const service = new Service({
		logger: project.logger,
		project: {
			cacheRoot: project.cacheRoot,
			externals: project.externals,
			projectRoots: [],
		},
	})
	t.after(() => service.project.close())
	service.project.symbols.query(doc, 'function', 'demo:name').enter({ data: {} })
	const symbol = service.project.symbols.global.function!['demo:name']
	return { service, symbol }
}

function file(symbol: Symbol): FileNode<SymbolNode> {
	const node = SymbolNode.mock(Range.create(0, 4), { category: 'function' })
	node.symbol = symbol
	const ans: FileNode<SymbolNode> = {
		type: 'file',
		range: node.range,
		children: [node],
		locals: {},
		parserErrors: [],
	}
	AstNode.setParents(ans)
	return ans
}

function location(type: SymbolUsageType, fromFile = false): SymbolLocation {
	return { uri: `file:///pack/${type}.mcfunction`, range: Range.create(0), fromFile }
}

describe('Service.getDefinitionLocations()', () => {
	const cases: {
		usages: SymbolUsageType[]
		normal: SymbolUsageType | undefined
		fileOrigin: SymbolUsageType | undefined
	}[] = [
		{
			usages: ['definition', 'declaration', 'implementation'],
			normal: 'definition',
			fileOrigin: 'definition',
		},
		{
			usages: ['declaration', 'implementation'],
			normal: 'declaration',
			fileOrigin: 'implementation',
		},
		{ usages: ['implementation'], normal: 'implementation', fileOrigin: 'implementation' },
		{ usages: ['declaration'], normal: 'declaration', fileOrigin: 'declaration' },
		{ usages: [], normal: undefined, fileOrigin: undefined },
	]
	for (const fromFile of [false, true]) {
		for (const { usages, normal, fileOrigin } of cases) {
			it(`selects the first available target (${usages.join(',')}; fromFile: ${fromFile})`, async t => {
				const { service, symbol } = setup(t)
				for (const type of usages) {
					symbol[type] = [location(type, fromFile && type !== 'declaration')]
				}
				if (fromFile && !usages.includes('definition') && !usages.includes('implementation')) {
					symbol.isotopes = [{
						identifier: 'other',
						scope: 0,
						visibleWithin: ['**/other/**'],
						implementation: [location('implementation', true)],
					}]
				}
				const expected = fromFile ? fileOrigin : normal
				const result = await service.getDefinitionLocations(file(symbol), doc, 1)
				t.assert.equal(result?.locations?.[0].uri, expected && location(expected).uri)
			})
		}
	}
	it('uses the selected isotope and hides targets outside its scope', async t => {
		const { service, symbol } = setup(t)
		symbol.visibility = 3
		symbol.isotopes = [{
			identifier: 'private',
			scope: 0,
			visibleWithin: ['**/private/**'],
			declaration: [location('declaration')],
			implementation: [location('implementation', true)],
		}, {
			identifier: 'other',
			scope: 0,
			visibleWithin: ['**/other/**'],
			definition: [location('definition', true)],
		}]
		const node = file(symbol)
		t.assert.equal((await service.getDefinitionLocations(node, doc, 1))?.locations?.[0].uri,
			location('implementation').uri)
		const outside = TextDocument.create('file:///pack/outside.mcfunction', 'mcfunction', 0, 'name')
		t.assert.equal(await service.getDefinitionLocations(node, outside, 1), undefined)
	})
	it('uses the file origin of the resolved alias target', async t => {
		const { service, symbol } = setup(t)
		symbol.declaration = [location('declaration')]
		symbol.implementation = [location('implementation', true)]
		service.project.symbols.query(doc, 'function', 'demo:alias').enter({
			data: { relations: { aliasOf: { category: 'function', path: ['demo:name'] } } },
		})
		const alias = service.project.symbols.global.function!['demo:alias']
		t.assert.equal((await service.getDefinitionLocations(file(alias), doc, 1))?.locations?.[0].uri,
			location('implementation').uri)
	})
	it('falls back when a preferred target cannot be mapped to disk', async t => {
		const { service, symbol } = setup(t)
		symbol.definition = [{ ...location('definition', true), uri: 'unmapped://definition' }]
		symbol.declaration = [location('declaration')]
		symbol.implementation = [location('implementation', true)]
		service.project.fs.mapToDisk = async () => undefined
		t.assert.equal((await service.getDefinitionLocations(file(symbol), doc, 1))?.locations?.[0].uri,
			location('implementation').uri)
	})
	it('preserves combined usages and current-file filtering for other navigation requests', async t => {
		const { service, symbol } = setup(t)
		symbol.declaration = [location('declaration')]
		symbol.implementation = [location('implementation', true)]
		symbol.reference = [{ uri, range: Range.create(0) }]
		const node = file(symbol)
		const all = await service.getSymbolLocations(node, doc, 1)
		t.assert.equal(all?.locations?.length, 3)
		const references = await service.getSymbolLocations(node, doc, 1, ['reference'], true)
		t.assert.deepEqual(references?.locations?.map(value => value.uri), [uri])
	})
})
