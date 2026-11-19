#!/usr/bin/env python3
"""Preserve and harden exactly two reviewed backup artifacts; never read dump contents."""
from __future__ import annotations

import argparse
import contextlib
import ctypes
import fcntl
import grp
import json
import os
from pathlib import Path
import pwd
import stat
import sys
import tempfile

BACKUP_DIR = "/var/backups/growth"
STATE_DIR = "/var/lib/growth-mailbox-backup-repair"
EMPTY = "deploy-20261105T221639Z.dump"
NONEMPTY = "deploy-20261105T134106Z.dump"
FILES = {EMPTY: {"size": 0, "mode": 0o664}, NONEMPTY: {"size": 7489697, "mode": 0o664}}
IDENTITY_KEYS = {"dev", "ino", "size", "uid", "gid", "nlink", "mtime_ns"}


def _growth_ids():
    return pwd.getpwnam("growth").pw_uid, grp.getgrnam("growth").gr_gid


def _checkpoint(label):
    """Named interruption boundaries; no operator-controlled test configuration."""


def _directory(path, uid, gid, mode=None):
    s = os.lstat(path)
    if not stat.S_ISDIR(s.st_mode) or (s.st_uid, s.st_gid) != (uid, gid):
        raise RuntimeError("unsafe directory identity")
    actual = stat.S_IMODE(s.st_mode)
    if (mode is not None and actual != mode) or actual & 0o022:
        raise RuntimeError("unsafe directory permissions")
    return s


def _trusted_parents(path):
    for parent in Path(path).parents:
        _directory(parent, 0, 0)


def _identity(s):
    return dict(dev=s.st_dev, ino=s.st_ino, size=s.st_size, uid=s.st_uid,
                gid=s.st_gid, nlink=s.st_nlink, mtime_ns=s.st_mtime_ns)


def _sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _rename_noreplace(source, destination):
    # Unlike rename(), this cannot silently replace an existing quarantine artifact.
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, "renameat2", None)
    if rename is None:
        raise RuntimeError("atomic no-replace rename unavailable")
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(source), -100, os.fsencode(destination), 1):
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


class Repair:
    def __init__(self):
        self.backups = Path(BACKUP_DIR)
        self.state = Path(STATE_DIR)
        self.journal = self.state / "journal.json"
        self.uid, self.gid = _growth_ids()

    @contextlib.contextmanager
    def _opened(self, path, size, modes, expected=None):
        before = os.lstat(path)
        if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1
                or before.st_size != size or (before.st_uid, before.st_gid) != (self.uid, self.gid)
                or stat.S_IMODE(before.st_mode) not in modes):
            raise RuntimeError("unexpected backup metadata")
        if expected is not None and _identity(before) != expected:
            raise RuntimeError("backup identity changed")
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
        try:
            if (_identity(os.fstat(fd)) != _identity(before)
                    or _identity(os.lstat(path)) != _identity(before)):
                raise RuntimeError("backup changed while opening")
            yield fd
            if _identity(os.fstat(fd)) != _identity(before):
                raise RuntimeError("backup changed during operation")
        finally:
            os.close(fd)

    def _initial(self):
        entries = {}
        for name, spec in FILES.items():
            if os.path.lexists(self.state / name):
                raise RuntimeError("unrecorded quarantine destination exists")
            with self._opened(self.backups / name, spec["size"], {0o664, 0o600}) as fd:
                s = os.fstat(fd)
                entries[name] = {"identity": _identity(s), "original_mode": stat.S_IMODE(s.st_mode)}
        return {"version": 1, "state": "prepared", "files": entries}

    def _journal_stat(self):
        s = os.lstat(self.journal)
        if (not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_size > 16384
                or (s.st_uid, s.st_gid) != (0, 0) or stat.S_IMODE(s.st_mode) != 0o600):
            raise RuntimeError("unsafe audit file")
        return s

    def _load(self):
        if not os.path.lexists(self.journal):
            return None
        before = self._journal_stat()
        fd = os.open(self.journal, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "r", encoding="utf8") as stream:
            if _identity(os.fstat(stream.fileno())) != _identity(before):
                raise RuntimeError("audit identity changed")
            record = json.load(stream)
        if (set(record) != {"version", "state", "files"} or record["version"] != 1
                or record["state"] not in {"prepared", "complete"}
                or set(record["files"]) != set(FILES)):
            raise RuntimeError("audit schema conflict")
        for name, item in record["files"].items():
            if set(item) != {"identity", "original_mode"} or item["original_mode"] not in {0o664, 0o600}:
                raise RuntimeError("audit entry conflict")
            identity = item["identity"]
            if (set(identity) != IDENTITY_KEYS or any(type(v) is not int for v in identity.values())
                    or identity["size"] != FILES[name]["size"] or identity["nlink"] != 1
                    or (identity["uid"], identity["gid"]) != (self.uid, self.gid)):
                raise RuntimeError("audit metadata conflict")
        return record

    def _save(self, record, initial=False):
        if not initial:
            self._journal_stat()
        fd, temporary = tempfile.mkstemp(prefix=".audit-", dir=self.state)
        try:
            with os.fdopen(fd, "w", encoding="utf8") as stream:
                os.fchmod(stream.fileno(), 0o600)
                json.dump(record, stream, sort_keys=True)
                stream.flush()
                os.fsync(stream.fileno())
            if initial:
                os.link(temporary, self.journal, follow_symlinks=False)
                os.unlink(temporary)
            else:
                os.replace(temporary, self.journal)
            _sync_directory(self.state)
        finally:
            if os.path.lexists(temporary):
                os.unlink(temporary)

    def _positions(self, record):
        src, dst = self.backups / EMPTY, self.state / EMPTY
        has_src, has_dst = os.path.lexists(src), os.path.lexists(dst)
        if has_src == has_dst:
            raise RuntimeError("empty artifact location conflict")
        empty = src if has_src else dst
        modes = {0o664, 0o600} if has_src else {0o600}
        with self._opened(empty, 0, modes, record["files"][EMPTY]["identity"]):
            pass
        with self._opened(self.backups / NONEMPTY, FILES[NONEMPTY]["size"], {0o664, 0o600},
                          record["files"][NONEMPTY]["identity"]):
            pass
        if record["state"] == "complete":
            if has_src or stat.S_IMODE(os.lstat(self.backups / NONEMPTY).st_mode) != 0o600:
                raise RuntimeError("completed repair changed")
        return empty

    def _tighten(self, path, name, record):
        changed = False
        with self._opened(path, FILES[name]["size"], {0o664, 0o600},
                          record["files"][name]["identity"]) as fd:
            if stat.S_IMODE(os.fstat(fd).st_mode) != 0o600:
                os.fchmod(fd, 0o600)
                os.fsync(fd)
                changed = True
            if stat.S_IMODE(os.fstat(fd).st_mode) != 0o600:
                raise RuntimeError("permission readback failed")
        return changed

    @contextlib.contextmanager
    def _lock(self):
        path = self.state / "lock"
        try:
            fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except FileExistsError:
            fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            s = os.fstat(fd)
            if (not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or (s.st_uid, s.st_gid) != (0, 0)
                    or stat.S_IMODE(s.st_mode) != 0o600 or _identity(os.lstat(path)) != _identity(s)):
                raise RuntimeError("unsafe lock")
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield
        finally:
            os.close(fd)

    def run(self, mode):
        if mode not in {"check", "repair"} or os.geteuid() != 0 or os.getegid() != 0:
            raise RuntimeError("root and explicit supported mode required")
        _trusted_parents(self.backups)
        _trusted_parents(self.state)
        backup_stat = _directory(self.backups, self.uid, self.gid, 0o700)
        exists = os.path.lexists(self.state)
        if exists:
            _directory(self.state, 0, 0, 0o700)
        record = self._load() if exists else None
        if record is None:
            record = self._initial()
        else:
            self._positions(record)
        if mode == "check":
            return {"state": record["state"] if exists and os.path.lexists(self.journal) else "initial",
                    "checked": 2, "changed": False}
        if not exists:
            os.mkdir(self.state, 0o700)
        state_stat = _directory(self.state, 0, 0, 0o700)
        if state_stat.st_dev != backup_stat.st_dev:
            raise RuntimeError("quarantine requires the same filesystem")
        with self._lock():
            stored = self._load()
            if stored is None:
                record = self._initial()
                self._save(record, initial=True)
            else:
                record = stored
            self._positions(record)
            if record["state"] == "complete":
                return {"state": "complete", "checked": 2, "changed": False}
            _checkpoint("prepared")
            changed = self._tighten(self.backups / NONEMPTY, NONEMPTY, record)
            _checkpoint("nonempty_hardened")
            empty = self._positions(record)
            changed = self._tighten(empty, EMPTY, record) or changed
            _checkpoint("empty_hardened")
            if empty == self.backups / EMPTY:
                with self._opened(empty, 0, {0o600}, record["files"][EMPTY]["identity"]):
                    _rename_noreplace(empty, self.state / EMPTY)
                _sync_directory(self.backups)
                _sync_directory(self.state)
                changed = True
            _checkpoint("empty_moved")
            record["state"] = "complete"
            self._positions(record)
            self._save(record)
            _checkpoint("complete")
            return {"state": "complete", "checked": 2, "quarantined": 1,
                    "hardened": 2, "changed": changed}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--check", action="store_true")
    modes.add_argument("--repair", action="store_true")
    args = parser.parse_args(argv)
    try:
        print(json.dumps(Repair().run("check" if args.check else "repair"), sort_keys=True))
        return 0
    except (OSError, RuntimeError, ValueError, KeyError, TypeError) as exc:
        print(json.dumps({"state": "refused", "error_type": type(exc).__name__}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())