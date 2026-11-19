#!/usr/bin/env python3
"""Real Linux filesystem tests; only account resolution and trusted anchor are substituted."""
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest import mock

SCRIPT = Path(sys.argv.pop(1)).resolve()
spec = importlib.util.spec_from_file_location("mailbox_backup_repair", SCRIPT)
assert spec is not None and spec.loader is not None
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)


class RepairHarness(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="mailbox-repair-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.backups, self.state = self.root / "backups", self.root / "state"
        self.backups.mkdir(mode=0o700)
        self.empty, self.large = self.backups / repair.EMPTY, self.backups / repair.NONEMPTY
        self.empty.write_bytes(b"")
        with self.large.open("wb") as stream:
            stream.write(b"synthetic-mailbox-backup-test\n")
            stream.truncate(7489697)
        os.chmod(self.empty, 0o664)
        os.chmod(self.large, 0o664)
        self.keep = self.backups / "unrelated.keep"
        self.keep.write_bytes(b"leave-me-unchanged")
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(mock.patch.object(repair, "BACKUP_DIR", str(self.backups)))
        stack.enter_context(mock.patch.object(repair, "STATE_DIR", str(self.state)))
        stack.enter_context(mock.patch.object(repair, "_growth_ids", return_value=(os.getuid(), os.getgid())))

        def trusted(path):
            if Path(path).parent != self.root:
                raise RuntimeError("fixture root escaped")
            repair._directory(self.root, os.getuid(), os.getgid(), 0o700)

        stack.enter_context(mock.patch.object(repair, "_trusted_parents", side_effect=trusted))

    def run_repair(self):
        return repair.Repair().run("repair")

    def assert_refused(self):
        with self.assertRaises((OSError, RuntimeError, ValueError, KeyError, TypeError)):
            self.run_repair()
        self.assertEqual(self.keep.read_bytes(), b"leave-me-unchanged")

    def assert_complete(self):
        self.assertFalse(self.empty.exists())
        self.assertEqual((self.state / repair.EMPTY).read_bytes(), b"")
        self.assertEqual(stat.S_IMODE((self.state / repair.EMPTY).stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.large.stat().st_mode), 0o600)
        self.assertEqual(self.keep.read_bytes(), b"leave-me-unchanged")
        self.assertEqual(repair.Repair().run("check")["state"], "complete")

    def test_check_is_read_only_without_state_directory(self):
        self.assertFalse(repair.Repair().run("check")["changed"])
        self.assertFalse(self.state.exists())
        self.assertEqual(stat.S_IMODE(self.large.stat().st_mode), 0o664)
        self.assertEqual(stat.S_IMODE(self.empty.stat().st_mode), 0o664)

    def test_repair_preserves_bytes_inodes_and_unrelated_files(self):
        before = (self.large.stat().st_ino, self.empty.stat().st_ino)
        digest = hashlib.sha256(self.large.read_bytes()).digest()
        self.assertTrue(self.run_repair()["changed"])
        self.assert_complete()
        self.assertEqual(self.large.stat().st_ino, before[0])
        self.assertEqual((self.state / repair.EMPTY).stat().st_ino, before[1])
        self.assertEqual(hashlib.sha256(self.large.read_bytes()).digest(), digest)
        audit = json.loads((self.state / "journal.json").read_text())
        self.assertEqual(set(audit["files"]), set(repair.FILES))
        self.assertTrue(all(v["original_mode"] == 0o664 for v in audit["files"].values()))

    def test_repeat_is_unchanged(self):
        self.run_repair()
        self.assertFalse(self.run_repair()["changed"])
        self.assert_complete()

    def test_wrong_size(self):
        self.large.write_bytes(b"short")
        self.assert_refused()
        self.assertFalse(self.state.exists())

    def test_wrong_mode(self):
        os.chmod(self.large, 0o640)
        self.assert_refused()
        self.assertFalse(self.state.exists())

    def test_symlink(self):
        self.large.unlink()
        self.large.symlink_to(self.keep)
        self.assert_refused()

    def test_hardlink(self):
        os.link(self.large, self.backups / "alias")
        self.assert_refused()

    def test_missing_input(self):
        self.empty.unlink()
        self.assert_refused()

    def test_directory_instead_of_file(self):
        self.empty.unlink()
        self.empty.mkdir(mode=0o755)
        self.assert_refused()

    def test_destination_collision(self):
        self.state.mkdir(mode=0o700)
        target = self.state / repair.EMPTY
        target.write_bytes(b"occupied")
        self.assert_refused()
        self.assertEqual(target.read_bytes(), b"occupied")

    def test_no_replace_race(self):
        def collide(label):
            if label == "empty_hardened":
                (self.state / repair.EMPTY).write_bytes(b"occupied")
        with mock.patch.object(repair, "_checkpoint", side_effect=collide):
            self.assert_refused()
        self.assertEqual((self.state / repair.EMPTY).read_bytes(), b"occupied")
        self.assertTrue(self.empty.exists())

    def test_unsafe_state_mode(self):
        self.state.mkdir(mode=0o755)
        self.assert_refused()

    def test_state_symlink(self):
        self.state.symlink_to(self.backups, target_is_directory=True)
        self.assert_refused()

    def test_unsafe_ancestor(self):
        os.chmod(self.root, 0o777)
        self.assert_refused()

    def test_wrong_expected_backup_owner(self):
        with mock.patch.object(repair, "_growth_ids", return_value=(99999, os.getgid())):
            self.assert_refused()

    def test_wrong_expected_backup_group(self):
        with mock.patch.object(repair, "_growth_ids", return_value=(os.getuid(), 99999)):
            self.assert_refused()

    def test_nonroot_guard(self):
        with mock.patch.object(repair.os, "geteuid", return_value=999):
            self.assert_refused()
            self.assertEqual(repair.main(["--check"]), 1)

    def test_lock_contention(self):
        import fcntl
        self.state.mkdir(mode=0o700)
        fd = os.open(self.state / "lock", os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assert_refused()
        finally:
            os.close(fd)

    def test_unsafe_existing_lock(self):
        self.state.mkdir(mode=0o700)
        (self.state / "lock").write_bytes(b"")
        os.chmod(self.state / "lock", 0o664)
        self.assert_refused()

    def test_audit_conflict(self):
        self.state.mkdir(mode=0o700)
        (self.state / "journal.json").write_text('{"version":0}')
        os.chmod(self.state / "journal.json", 0o600)
        self.assert_refused()

    def test_inode_change_after_prepared_audit(self):
        def interrupt(label):
            if label == "prepared":
                raise RuntimeError("synthetic interruption")
        with mock.patch.object(repair, "_checkpoint", side_effect=interrupt):
            self.assert_refused()
        old_inode = self.large.stat().st_ino
        self.large.rename(self.backups / "preserved-original")
        with self.large.open("wb") as stream:
            stream.truncate(7489697)
        os.chmod(self.large, 0o664)
        self.assertNotEqual(self.large.stat().st_ino, old_inode)
        self.assert_refused()

    def test_completed_drift_refuses_instead_of_repairing(self):
        self.run_repair()
        os.chmod(self.large, 0o664)
        self.assert_refused()
        self.assertEqual(stat.S_IMODE(self.large.stat().st_mode), 0o664)


def interruption_test(label):
    def test(self):
        def interrupt(current):
            if current == label:
                raise RuntimeError("synthetic interruption")
        with mock.patch.object(repair, "_checkpoint", side_effect=interrupt):
            self.assert_refused()
        self.assertEqual(self.run_repair()["state"], "complete")
        self.assert_complete()
    return test


for boundary in ("prepared", "nonempty_hardened", "empty_hardened", "empty_moved", "complete"):
    setattr(RepairHarness, "test_resume_after_" + boundary, interruption_test(boundary))

if __name__ == "__main__":
    unittest.main(verbosity=2)