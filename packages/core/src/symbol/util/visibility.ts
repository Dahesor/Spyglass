import picomatch from 'picomatch'
import { ResourceLocation } from '../../common/index.js'
import type { IsotopeVisibility } from '../Symbol.js'

export type ResourceLocationResolver = (uri: string) => ResourceLocation | undefined

// It should be quite common for multiple symbols/isotopes to share the same scope
// So caching should help here
interface VisibilityPredicate {
	matches(uri: string, location?: Omit<ResourceLocation, 'isTag'>): boolean
}
interface CachedVisibility {
	rules: IsotopeVisibility[]
	cache: VisibilityPredicate
}
const byRules = new WeakMap<IsotopeVisibility[], CachedVisibility>()
const sharedScopes = new Map<string, CachedVisibility>()
const MaxSharedScopes = 2048

/** @returns `true` if the given URI matches the specified visibility rules. */
export function matchesVisibility(
	rules: IsotopeVisibility[],
	uri: string,
	location?: Omit<ResourceLocation, 'isTag'>,
): boolean {
	// Fast path for non-glob rules
	if (rules.length === 1 && rules[0].glob === undefined) {
		const { namespace, path } = rules[0]
		if (namespace === undefined && path === undefined) {
			return true
		}
		if (
			!location
			|| (namespace !== undefined
				&& namespace !== (location.namespace ?? ResourceLocation.DefaultNamespace))
		) {
			return false
		}
		if (path === undefined) {
			return true
		}
		const identifier = resourcePath(location)
		return identifier.startsWith(path)
			&& (path === '' || path.endsWith('/') || identifier[path.length] === '/')
	}
	return getVisibilityScope(rules).matches(uri, location)
}

function getVisibilityScope(rules: IsotopeVisibility[]): VisibilityPredicate {
	const existing = byRules.get(rules)
	if (existing && validateCache(rules, existing.rules)) {
		return existing.cache
	}
	const key = JSON.stringify(rules.map(rule => [rule.namespace, rule.path, rule.glob]))
	let cached = sharedScopes.get(key)
	if (!cached) {
		const snapshot = rules.map(rule => ({
			namespace: rule.namespace,
			path: rule.path,
			glob: rule.glob,
		}))
		const matchers = snapshot.map(rule => {
			const glob = rule.glob?.length ? picomatch(rule.glob, { dot: true }) : undefined
			const path = rule.path === undefined || rule.path === '' || rule.path.endsWith('/')
				? rule.path
				: rule.path + '/'
			return (uri: string, location?: Omit<ResourceLocation, 'isTag'>): boolean => {
				if (rule.namespace !== undefined || path !== undefined) {
					if (
						!location
						|| (rule.namespace !== undefined
							&& rule.namespace
								!== (location.namespace ?? ResourceLocation.DefaultNamespace))
						|| (path !== undefined && !resourcePath(location).startsWith(path))
					) {
						return false
					}
				}
				// An explicitly empty glob string matches nothing
				return rule.glob !== undefined ? !!glob?.(uri) : true
			}
		})
		let lastUri: string | undefined
		let lastResult = false
		let lastNamespace: string | undefined
		let lastIdentifier: string | undefined
		cached = {
			rules: snapshot,
			cache: {
				matches(uri, location) {
					if (
						uri !== lastUri || (location
								? location.namespace ?? ResourceLocation.DefaultNamespace
								: undefined) !== lastNamespace
						|| (location ? resourcePath(location) : undefined) !== lastIdentifier
					) {
						lastUri = uri
						lastNamespace = location
							? location.namespace ?? ResourceLocation.DefaultNamespace
							: undefined
						lastIdentifier = location ? resourcePath(location) : undefined
						lastResult = matchers.some(match => match(uri, location))
					}
					return lastResult
				},
			},
		}
		if (sharedScopes.size >= MaxSharedScopes) {
			sharedScopes.delete(sharedScopes.keys().next().value!)
		}
		sharedScopes.set(key, cached)
	}
	byRules.set(rules, cached)
	return cached.cache
}

function validateCache(rules: IsotopeVisibility[], snapshot: IsotopeVisibility[]): boolean {
	if (rules.length !== snapshot.length) {
		return false
	}
	for (let i = 0; i < rules.length; i++) {
		const rule = rules[i]
		const previous = snapshot[i]
		if (
			rule.namespace !== previous.namespace || rule.path !== previous.path
			|| rule.glob !== previous.glob
		) {
			return false
		}
	}
	return true
}

const joinedPaths = new WeakMap<readonly string[], string>()
function resourcePath(location: Omit<ResourceLocation, 'isTag'>): string {
	const path = location.path
	if (!Object.isFrozen(path)) {
		return path.join(ResourceLocation.PathSep)
	}
	let joined = joinedPaths.get(path)
	if (joined === undefined) {
		joined = path.join(ResourceLocation.PathSep)
		joinedPaths.set(path, joined)
	}
	return joined
}
