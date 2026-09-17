#!/usr/bin/env python3
"""Validate and safely extract the exact npm pack artifact used by release gates."""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import tarfile
from pathlib import Path, PurePosixPath


def fail(message: str) -> "NoReturn":
    print(f"artifact verification failed: {message}", file=sys.stderr)
    raise SystemExit(1)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact", required=True, type=Path)
    parser.add_argument("--expected-package", required=True)
    parser.add_argument("--expected-version", required=True)
    parser.add_argument("--extract-dir", required=True, type=Path)
    return parser.parse_args()


def safe_member_path(name: str, destination: Path) -> Path:
    if not name or "\\" in name:
        fail(f"unsafe archive member name: {name!r}")
    relative = PurePosixPath(name)
    if relative.is_absolute() or any(part in ("", ".", "..") for part in relative.parts):
        fail(f"unsafe archive member path: {name!r}")
    if not relative.parts or relative.parts[0] != "package":
        fail(f"archive member is outside npm package root: {name!r}")
    target = (destination / Path(*relative.parts)).resolve()
    root = destination.resolve()
    if target != root and root not in target.parents:
        fail(f"archive member escapes extraction directory: {name!r}")
    return target


def main() -> None:
    args = parse_args()
    artifact = args.artifact.resolve()
    if not artifact.is_file():
        fail(f"artifact does not exist: {artifact}")
    artifact_bytes = artifact.stat().st_size
    if artifact_bytes <= 0:
        fail(f"artifact is empty: {artifact}")

    destination = args.extract_dir.resolve()
    if destination.exists():
        if destination.is_symlink() or not destination.is_dir():
            fail(f"extraction path is not a directory: {destination}")
        shutil.rmtree(destination)
    destination.mkdir(parents=True)

    names: set[str] = set()
    extracted_bytes = 0
    try:
        with tarfile.open(artifact, mode="r:gz") as archive:
            members = archive.getmembers()
            if not members:
                fail("archive has no members")
            for member in members:
                target = safe_member_path(member.name, destination)
                if member.name in names:
                    fail(f"duplicate archive member: {member.name!r}")
                names.add(member.name)
                if member.issym() or member.islnk():
                    fail(f"links are not permitted in package artifacts: {member.name!r}")
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                if not member.isreg():
                    fail(f"unsupported archive member type: {member.name!r}")
                target.parent.mkdir(parents=True, exist_ok=True)
                source = archive.extractfile(member)
                if source is None:
                    fail(f"unable to read archive member: {member.name!r}")
                with source, target.open("wb") as output:
                    while chunk := source.read(1024 * 1024):
                        output.write(chunk)
                        extracted_bytes += len(chunk)
    except (tarfile.TarError, OSError) as error:
        fail(str(error))

    manifest_path = destination / "package" / "package.json"
    if not manifest_path.is_file():
        fail("package/package.json is missing")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"invalid package manifest: {error}")
    if manifest.get("name") != args.expected_package:
        fail(f"packed name {manifest.get('name')!r} != {args.expected_package!r}")
    if manifest.get("version") != args.expected_version:
        fail(f"packed version {manifest.get('version')!r} != {args.expected_version!r}")
    if manifest.get("main") != "./dist/node/index.js":
        fail("packed main does not point at the Node distribution")
    if manifest.get("types") != "./dist/index.d.ts":
        fail("packed types does not point at declarations")
    exports = manifest.get("exports", {}).get(".", {})
    if exports.get("browser") != "./dist/browser/index.js":
        fail("packed browser export does not point at the browser distribution")
    if exports.get("node") != "./dist/node/index.js":
        fail("packed node export does not point at the Node distribution")
    dependencies = manifest.get("dependencies", {})
    if "@microsoft/signalr" not in dependencies:
        fail("packed dependencies do not include @microsoft/signalr")

    required_files = {
        "package/dist/node/index.js",
        "package/dist/browser/index.js",
        "package/dist/index.d.ts",
    }
    missing = sorted(required_files - names)
    if missing:
        fail(f"required packed files are missing: {', '.join(missing)}")

    digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
    print(json.dumps({
        "artifact": str(artifact),
        "sha256": digest,
        "artifact_bytes": artifact_bytes,
        "extracted_bytes": extracted_bytes,
        "members": len(names),
        "package": manifest["name"],
        "version": manifest["version"],
    }, sort_keys=True))


if __name__ == "__main__":
    main()
