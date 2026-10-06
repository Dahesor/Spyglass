import { describe, it } from 'node:test'
import { TextDocument } from 'vscode-languageserver-textdocument'
import type { FileNode, Symbol, SymbolLocation, SymbolUsageType } from '../../lib/index.js'
import {
	AstNode,
	GlobalSymbol,
	Logger,
	Range,
	Service,
	SymbolIsotopeProvider,
	SymbolIsotopeScope,
	SymbolNode,
	SymbolTable,
	SymbolUtil,
} from '../../lib/index.js'
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
	for (const scope of [SymbolIsotopeScope.Global, SymbolIsotopeScope.Namespace]) {
		it(`finds consumer references and implementations from a dependency declaration (scope: ${scope})`, async t => {
			const { service } = setup(t)
			const declarationDoc = TextDocument.create(
				'file:///dependency/data/demo/function/doc.mcfunction',
				'mcfunction',
				0,
				'name',
			)
			const dependency = new SymbolUtil({})
			dependency.query(declarationDoc, 'objective', 'aaaaaa').enterIsotope('doc', {
				data: {
					scope,
					source: SymbolIsotopeProvider.DocBlock,
					origin: { uri: declarationDoc.uri },
					...(scope === SymbolIsotopeScope.Namespace
						? { namespace: ['demo'], visibleWithin: ['**'] }
						: {}),
				},
				usage: { type: 'declaration', fromDocDeclaration: true, range: Range.create(0, 4) },
			})
			dependency.query(declarationDoc, 'objective', 'aaaaaa').enterCommand({
				usage: { type: 'reference', range: Range.create(1, 2) },
			})
			const source = dependency.global.objective!['aaaaaa']
			GlobalSymbol.importDependencySymbols(
				service.project.symbols,
				SymbolTable.getDependencyExports(dependency.global, 'package'),
			)
			const consumerDoc = TextDocument.create(
				'file:///pack/data/demo/function/use.mcfunction',
				'mcfunction',
				0,
				'name',
			)
			service.project.symbols.query(consumerDoc, 'objective', 'aaaaaa').enterCommand({
				usage: { type: 'reference', range: Range.create(0, 4) },
			})
			service.project.symbols.query(consumerDoc, 'objective', 'aaaaaa').enterCommand({
				usage: { type: 'definition', range: Range.create(0, 4) },
			})
			const references = await service.getSymbolLocations(file(source), declarationDoc, 1, [
				'reference',
			])
			t.assert.deepEqual(references?.locations?.map(value => value.uri), [
				declarationDoc.uri,
				consumerDoc.uri,
			])
			const implementations = await service.getSymbolLocations(file(source), declarationDoc, 1, [
				'implementation',
			])
			t.assert.deepEqual(implementations?.locations?.map(value => value.uri), [consumerDoc.uri])
			const local = await service.getSymbolLocations(file(source), declarationDoc, 1, [
				'reference',
			], true)
			t.assert.deepEqual(local?.locations?.map(value => value.uri), [declarationDoc.uri])
		})
	}
	it('does not associate same-named dependency isotopes with a different package', async t => {
		const { service } = setup(t)
		const makeDependency = (uri: string) => {
			const symbols = new SymbolUtil({})
			symbols.query(uri, 'objective', 'aaaaaa').enterIsotope('doc', {
				data: {
					scope: SymbolIsotopeScope.Global,
					source: SymbolIsotopeProvider.DocBlock,
					origin: { uri },
				},
				usage: { type: 'declaration', fromDocDeclaration: true },
			})
			return symbols
		}
		const first = makeDependency('file:///dependency/first.mcfunction')
		const second = makeDependency('file:///dependency/second.mcfunction')
		GlobalSymbol.importDependencySymbols(
			service.project.symbols,
			SymbolTable.getDependencyExports(second.global, 'second'),
		)
		service.project.symbols.query(doc, 'objective', 'aaaaaa').enterCommand({
			usage: { type: 'reference' },
		})
		const result = await service.getSymbolLocations(
			file(first.global.objective!['aaaaaa']),
			TextDocument.create('file:///dependency/first.mcfunction', 'mcfunction', 0, 'name'),
			1,
			['reference'],
		)
		t.assert.equal(result?.locations, undefined)
	})
	for (const scope of [SymbolIsotopeScope.Private, SymbolIsotopeScope.Project]) {
		it(`does not expose consumer usages after a dependency declaration becomes restricted (scope: ${scope})`, async t => {
			const { service } = setup(t)
			const dependency = new SymbolUtil({})
			dependency.query(doc, 'objective', 'aaaaaa').enterIsotope('doc', {
				data: {
					scope: SymbolIsotopeScope.Global,
					source: SymbolIsotopeProvider.DocBlock,
					origin: { uri },
				},
				usage: { type: 'declaration', fromDocDeclaration: true },
			})
			const source = dependency.global.objective!['aaaaaa']
			GlobalSymbol.importDependencySymbols(
				service.project.symbols,
				SymbolTable.getDependencyExports(dependency.global, 'package'),
			)
			service.project.symbols.query(doc, 'objective', 'aaaaaa').enterCommand({
				usage: { type: 'reference' },
			})
			const facet = source.facets!.global!
			delete source.facets!.global
			if (scope === SymbolIsotopeScope.Project) {
				source.facets!.internal = facet
			} else {
				source.facets!.isotopes = [{
					...facet.isotopes[0],
					scope,
					visibleWithin: ['**/private/**'],
					declaration: facet.declaration,
				}]
			}
			const result = await service.getSymbolLocations(file(source), doc, 1, ['reference'])
			t.assert.equal(result?.locations, undefined)
		})
	}
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
					symbol.facets!.global![type] = [location(type, fromFile && type !== 'declaration')]
				}
				if (fromFile && !usages.includes('definition') && !usages.includes('implementation')) {
					symbol.facets!.isotopes = [{
						identifier: 'other',
						source: 1,
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
		delete symbol.facets!.global
		symbol.facets!.isotopes = [{
			identifier: 'private',
			source: 1,
			scope: 0,
			visibleWithin: ['**/private/**'],
			declaration: [location('declaration')],
			implementation: [location('implementation', true)],
		}, {
			identifier: 'other',
			source: 1,
			scope: 0,
			visibleWithin: ['**/other/**'],
			definition: [location('definition', true)],
		}]
		const node = file(symbol)
		t.assert.equal(
			(await service.getDefinitionLocations(node, doc, 1))?.locations?.[0].uri,
			location('implementation').uri,
		)
		const outside = TextDocument.create(
			'file:///pack/outside.mcfunction',
			'mcfunction',
			0,
			'name',
		)
		t.assert.equal(await service.getDefinitionLocations(node, outside, 1), undefined)
	})
	it('uses the file origin of the resolved alias target', async t => {
		const { service, symbol } = setup(t)
		symbol.facets!.global!.declaration = [location('declaration')]
		symbol.facets!.global!.implementation = [location('implementation', true)]
		service.project.symbols.query(doc, 'function', 'demo:alias').enter({
			data: { relations: { aliasOf: { category: 'function', path: ['demo:name'] } } },
		})
		const alias = service.project.symbols.global.function!['demo:alias']
		t.assert.equal(
			(await service.getDefinitionLocations(file(alias), doc, 1))?.locations?.[0].uri,
			location('implementation').uri,
		)
	})
	it('falls back when a preferred target cannot be mapped to disk', async t => {
		const { service, symbol } = setup(t)
		symbol.facets!.global!.definition = [{
			...location('definition', true),
			uri: 'unmapped://definition',
		}]
		symbol.facets!.global!.declaration = [location('declaration')]
		symbol.facets!.global!.implementation = [location('implementation', true)]
		service.project.fs.mapToDisk = async () => undefined
		t.assert.equal(
			(await service.getDefinitionLocations(file(symbol), doc, 1))?.locations?.[0].uri,
			location('implementation').uri,
		)
	})
	it('preserves combined usages and current-file filtering for other navigation requests', async t => {
		const { service, symbol } = setup(t)
		symbol.facets!.global!.declaration = [location('declaration')]
		symbol.facets!.global!.implementation = [location('implementation', true)]
		symbol.facets!.global!.reference = [{ uri, range: Range.create(0) }]
		const node = file(symbol)
		const all = await service.getSymbolLocations(node, doc, 1)
		t.assert.equal(all?.locations?.length, 3)
		const references = await service.getSymbolLocations(node, doc, 1, ['reference'], true)
		t.assert.deepEqual(references?.locations?.map(value => value.uri), [uri])
	})
})
