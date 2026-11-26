import { SymbolService, SymbolUtil } from '@spyglassmc/core'
import * as mcdoc from '@spyglassmc/mcdoc'
import * as cp from 'child_process'
import { resolve } from 'path'
import { pathToFileURL } from 'url'
import { promisify } from 'util'
import { createLogger, createProject as createProject, sortMaps, writeJson } from '../common.js'

const execFile = promisify(cp.execFile)

interface Export {
	mcdoc: Map<string, mcdoc.McdocType>
	'mcdoc/dispatcher': Map<string, Map<string, mcdoc.McdocType>>
}

interface Args {
	source: string
	output: string
	gzip: boolean
	ref: boolean
	verbose: boolean
}
export async function exportCommand(args: Args) {
	const logger = createLogger(args.verbose)
	const project = await createProject(logger, args.source)

	const data: Export = {
		mcdoc: new Map(),
		'mcdoc/dispatcher': new Map(),
	}

	const service = new SymbolService(project.symbolStorage)
	const symbols = service.getVisibleSymbols('mcdoc')
	for (const [name, symbol] of Object.entries(symbols)) {
		const type = SymbolUtil.getCanonicalData(symbol)
		if (mcdoc.binder.TypeDefSymbolData.is(type)) {
			data.mcdoc.set(name, type.typeDef)
		}
	}
	const dispatchers = service.getVisibleSymbols('mcdoc/dispatcher')
	for (const [name, symbol] of Object.entries(dispatchers)) {
		const dispatcherMap = new Map()
		data['mcdoc/dispatcher'].set(name, dispatcherMap)
		for (const [id, member] of Object.entries(symbol.members ?? {})) {
			const type = SymbolUtil.getCanonicalData(member)
			if (mcdoc.binder.TypeDefSymbolData.is(type)) {
				dispatcherMap.set(id, type.typeDef)
			}
		}
	}

	const output = {
		...args.ref ? { ref: (await execFile('git', ['rev-parse', 'HEAD'])).stdout.trim() } : {},
		mcdoc: sortMaps(data.mcdoc),
		'mcdoc/dispatcher': sortMaps(data['mcdoc/dispatcher']),
	}
	const outputFile = pathToFileURL(resolve(process.cwd(), args.output)).toString()
	await writeJson(outputFile, output, args.gzip)

	await project.close()
}
