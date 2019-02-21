/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as extpath from 'vs/base/common/extpath';
import * as paths from 'vs/base/common/path';
import { URI } from 'vs/base/common/uri';
import { equalsIgnoreCase } from 'vs/base/common/strings';
import { Schemas } from 'vs/base/common/network';
import { isLinux, isWindows } from 'vs/base/common/platform';
import { CharCode } from 'vs/base/common/charCode';
import { ParsedExpression, IExpression, parse } from 'vs/base/common/glob';
import { TernarySearchTree } from 'vs/base/common/map';

export function getComparisonKey(resource: URI): string {
	return hasToIgnoreCase(resource) ? resource.toString().toLowerCase() : resource.toString();
}

export function hasToIgnoreCase(resource: URI | undefined): boolean {
	// A file scheme resource is in the same platform as code, so ignore case for non linux platforms
	// Resource can be from another platform. Lowering the case as an hack. Should come from File system provider
	return resource && resource.scheme === Schemas.file ? !isLinux : true;
}

export function basenameOrAuthority(resource: URI): string {
	return basename(resource) || resource.authority;
}

/**
 * Tests whether a `candidate` URI is a parent or equal of a given `base` URI.
 * @param base A uri which is "longer"
 * @param parentCandidate A uri which is "shorter" then `base`
 */
export function isEqualOrParent(base: URI, parentCandidate: URI, ignoreCase = hasToIgnoreCase(base)): boolean {
	if (base.scheme === parentCandidate.scheme) {
		if (base.scheme === Schemas.file) {
			return extpath.isEqualOrParent(originalFSPath(base), originalFSPath(parentCandidate), ignoreCase);
		}
		if (isEqualAuthority(base.authority, parentCandidate.authority)) {
			return extpath.isEqualOrParent(base.path, parentCandidate.path, ignoreCase, '/');
		}
	}
	return false;
}

/**
 * Tests wheter the two authorities are the same
 */
export function isEqualAuthority(a1: string, a2: string) {
	return a1 === a2 || equalsIgnoreCase(a1, a2);
}

export function isEqual(first: URI | undefined, second: URI | undefined, ignoreCase = hasToIgnoreCase(first)): boolean {
	if (first === second) {
		return true;
	}

	if (!first || !second) {
		return false;
	}

	if (first.scheme !== second.scheme || !isEqualAuthority(first.authority, second.authority)) {
		return false;
	}

	const p1 = first.path || '/', p2 = second.path || '/';
	return p1 === p2 || ignoreCase && equalsIgnoreCase(p1 || '/', p2 || '/');
}

export function basename(resource: URI): string {
	return paths.posix.basename(resource.path);
}

export function extname(resource: URI): string {
	return paths.posix.extname(resource.path);
}

/**
 * Return a URI representing the directory of a URI path.
 *
 * @param resource The input URI.
 * @returns The URI representing the directory of the input URI.
 */
export function dirname(resource: URI): URI {
	if (resource.path.length === 0) {
		return resource;
	}
	if (resource.scheme === Schemas.file) {
		return URI.file(paths.dirname(originalFSPath(resource)));
	}
	let dirname = paths.posix.dirname(resource.path);
	if (resource.authority && dirname.length && dirname.charCodeAt(0) !== CharCode.Slash) {
		console.error(`dirname("${resource.toString})) resulted in a relative path`);
		dirname = '/'; // If a URI contains an authority component, then the path component must either be empty or begin with a CharCode.Slash ("/") character
	}
	return resource.with({
		path: dirname
	});
}

/**
 * Join a URI path with path fragments and normalizes the resulting path.
 *
 * @param resource The input URI.
 * @param pathFragment The path fragment to add to the URI path.
 * @returns The resulting URI.
 */
export function joinPath(resource: URI, ...pathFragment: string[]): URI {
	let joinedPath: string;
	if (resource.scheme === Schemas.file) {
		joinedPath = URI.file(paths.join(originalFSPath(resource), ...pathFragment)).path;
	} else {
		joinedPath = paths.posix.join(resource.path || '/', ...pathFragment);
	}
	return resource.with({
		path: joinedPath
	});
}

/**
 * Normalizes the path part of a URI: Resolves `.` and `..` elements with directory names.
 *
 * @param resource The URI to normalize the path.
 * @returns The URI with the normalized path.
 */
export function normalizePath(resource: URI): URI {
	if (!resource.path.length) {
		return resource;
	}
	let normalizedPath: string;
	if (resource.scheme === Schemas.file) {
		normalizedPath = URI.file(paths.normalize(originalFSPath(resource))).path;
	} else {
		normalizedPath = paths.posix.normalize(resource.path);
	}
	return resource.with({
		path: normalizedPath
	});
}

/**
 * Returns the fsPath of an URI where the drive letter is not normalized.
 * See #56403.
 */
export function originalFSPath(uri: URI): string {
	let value: string;
	const uriPath = uri.path;
	if (uri.authority && uriPath.length > 1 && uri.scheme === 'file') {
		// unc path: file://shares/c$/far/boo
		value = `//${uri.authority}${uriPath}`;
	} else if (
		isWindows
		&& uriPath.charCodeAt(0) === CharCode.Slash
		&& extpath.isWindowsDriveLetter(uriPath.charCodeAt(1))
		&& uriPath.charCodeAt(2) === CharCode.Colon
	) {
		value = uriPath.substr(1);
	} else {
		// other path
		value = uriPath;
	}
	if (isWindows) {
		value = value.replace(/\//g, '\\');
	}
	return value;
}

/**
 * Returns true if the URI path is absolute.
 */
export function isAbsolutePath(resource: URI): boolean {
	return !!resource.path && resource.path[0] === '/';
}

/**
 * Returns true if the URI path has a trailing path separator
 */
export function hasTrailingPathSeparator(resource: URI): boolean {
	if (resource.scheme === Schemas.file) {
		const fsp = originalFSPath(resource);
		return fsp.length > extpath.getRoot(fsp).length && fsp[fsp.length - 1] === paths.sep;
	} else {
		let p = resource.path;
		return p.length > 1 && p.charCodeAt(p.length - 1) === CharCode.Slash; // ignore the slash at offset 0
	}
}


/**
 * Removes a trailing path seperator, if theres one.
 * Important: Doesn't remove the first slash, it would make the URI invalid
 */
export function removeTrailingPathSeparator(resource: URI): URI {
	if (hasTrailingPathSeparator(resource)) {
		return resource.with({ path: resource.path.substr(0, resource.path.length - 1) });
	}
	return resource;
}


/**
 * Returns a relative path between two URIs. If the URIs don't have the same schema or authority, `undefined` is returned.
 * The returned relative path always uses forward slashes.
 */
export function relativePath(from: URI, to: URI): string | undefined {
	if (from.scheme !== to.scheme || !isEqualAuthority(from.authority, to.authority)) {
		return undefined;
	}
	if (from.scheme === Schemas.file) {
		const relativePath = paths.relative(from.path, to.path);
		return isWindows ? extpath.toSlashes(relativePath) : relativePath;
	}
	return paths.posix.relative(from.path || '/', to.path || '/');
}

/**
 * Resolves a absolute or relative path against a base URI.
 */
export function resolvePath(base: URI, path: string): URI {
	let resolvedPath: string;
	if (base.scheme === Schemas.file) {
		resolvedPath = URI.file(paths.resolve(originalFSPath(base), path)).path;
	} else {
		resolvedPath = paths.posix.resolve(base.path, path);
	}
	return base.with({
		path: resolvedPath
	});
}

export function distinctParents<T>(items: T[], resourceAccessor: (item: T) => URI): T[] {
	const distinctParents: T[] = [];
	for (let i = 0; i < items.length; i++) {
		const candidateResource = resourceAccessor(items[i]);
		if (items.some((otherItem, index) => {
			if (index === i) {
				return false;
			}

			return isEqualOrParent(candidateResource, resourceAccessor(otherItem));
		})) {
			continue;
		}

		distinctParents.push(items[i]);
	}

	return distinctParents;
}

/**
 * Tests whether the given URL is a file URI created by `URI.parse` instead of `URI.file`.
 * Such URI have no scheme or scheme that consist of a single letter (windows drive letter)
 * @param candidate The URI to test
 * @returns A corrected, real file URI if the input seems to be malformed.
 * Undefined is returned if the input URI looks fine.
 */
export function isMalformedFileUri(candidate: URI): URI | undefined {
	if (!candidate.scheme || isWindows && candidate.scheme.match(/^[a-zA-Z]$/)) {
		return URI.file((candidate.scheme ? candidate.scheme + ':' : '') + candidate.path);
	}
	return undefined;
}


/**
 * Data URI related helpers.
 */
export namespace DataUri {

	export const META_DATA_LABEL = 'label';
	export const META_DATA_DESCRIPTION = 'description';
	export const META_DATA_SIZE = 'size';
	export const META_DATA_MIME = 'mime';

	export function parseMetaData(dataUri: URI): Map<string, string> {
		const metadata = new Map<string, string>();

		// Given a URI of:  data:image/png;size:2313;label:SomeLabel;description:SomeDescription;base64,77+9UE5...
		// the metadata is: size:2313;label:SomeLabel;description:SomeDescription
		const meta = dataUri.path.substring(dataUri.path.indexOf(';') + 1, dataUri.path.lastIndexOf(';'));
		meta.split(';').forEach(property => {
			const [key, value] = property.split(':');
			if (key && value) {
				metadata.set(key, value);
			}
		});

		// Given a URI of:  data:image/png;size:2313;label:SomeLabel;description:SomeDescription;base64,77+9UE5...
		// the mime is: image/png
		const mime = dataUri.path.substring(0, dataUri.path.indexOf(';'));
		if (mime) {
			metadata.set(META_DATA_MIME, mime);
		}

		return metadata;
	}
}


export class ResourceGlobMatcher {

	private readonly globalExpression: ParsedExpression;
	private readonly expressionsByRoot: TernarySearchTree<{ root: URI, expression: ParsedExpression }> = TernarySearchTree.forPaths<{ root: URI, expression: ParsedExpression }>();

	constructor(
		globalExpression: IExpression,
		rootExpressions: { root: URI, expression: IExpression }[]
	) {
		this.globalExpression = parse(globalExpression);
		for (const expression of rootExpressions) {
			this.expressionsByRoot.set(expression.root.toString(), { root: expression.root, expression: parse(expression.expression) });
		}
	}

	matches(resource: URI): boolean {
		const rootExpression = this.expressionsByRoot.findSubstr(resource.toString());
		if (rootExpression) {
			const path = relativePath(rootExpression.root, resource);
			if (path && !!rootExpression.expression(path)) {
				return true;
			}
		}
		return !!this.globalExpression(resource.path);
	}
}