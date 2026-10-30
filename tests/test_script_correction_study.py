"""Synthetic tests for private evaluation tooling; no user media/models required."""
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "study", Path(__file__).resolve().parents[1] / "scripts/script-correction-study.py")
study = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(study)


class StudyTests(unittest.TestCase):
    def setUp(self):
        self.project = {"version": 1, "media": {"m": {"duration": 20}}, "segments": [
            {"id": "one", "mediaId": "m", "sourceIn": 2, "sourceOut": 10,
             "words": [{"id": "word", "text": "hello", "start": 3, "end": 4}]},
            {"id": "two", "mediaId": "m", "sourceIn": 2, "sourceOut": 10,
             "words": [{"id": "word", "text": "hello", "start": 3, "end": 4}]},
        ]}
        self.case = {"id": "example", "split": "development", "segmentId": "one",
                     "sourceIn": 2, "sourceOut": 8, "scriptExcerpt": "hello",
                     "adversarialPrompt": "goodbye", "purpose": "intentional variation"}

    def test_requires_one_explicit_occurrence(self):
        segment, _, words = study.validate_case(self.case, self.project)
        self.assertEqual(segment["id"], "one")
        self.assertEqual(words[0]["id"], "word")
        with self.assertRaises(ValueError):
            study.validate_case({**self.case, "segmentId": "missing"}, self.project)

    def test_rejects_cross_cut_ranges_even_if_source_audio_exists(self):
        for start, end in [(1, 5), (3, 11), (2, 33)]:
            with self.subTest(start=start, end=end), self.assertRaises(ValueError):
                study.validate_case({**self.case, "sourceIn": start, "sourceOut": end}, self.project)

    def test_rejects_nonfinite_reversed_and_empty_ranges(self):
        for start, end in [(float("nan"), 4), (2, float("inf")), (5, 3), (3, 3), (True, 8), (5, 6)]:
            with self.subTest(start=start, end=end), self.assertRaises(ValueError):
                study.validate_case({**self.case, "sourceIn": start, "sourceOut": end}, self.project)

    def test_rejects_unsafe_ids_and_unassigned_splits(self):
        for change in [{"id": "../escape"}, {"id": "<script>"}, {"split": "unsplit"},
                       {"scriptExcerpt": ""}, {"adversarialPrompt": ""}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                study.validate_case({**self.case, **change}, self.project)

    def test_page_escapes_source_text_and_has_no_remote_dependencies(self):
        case = {**self.case, "purpose": "</script><img src=https://example.com>",
                "originalRecognition": "héllo 👋", "scriptExcerpt": "<press> QUERY"}
        page = study.label_page([case], "digest")
        self.assertIn("&lt;press&gt; QUERY", page)
        self.assertIn("héllo 👋", page)
        self.assertNotIn("<img", page)
        self.assertNotIn("fetch(", page)
        self.assertIn('studyId:"digest"', page)
        self.assertIn('src="example.wav"', page)

    def test_held_out_cannot_be_decoded_in_development(self):
        with tempfile.TemporaryDirectory() as folder:
            study.write_json(Path(folder) / "study.json", {
                "policy": study.POLICY, "status": "ready",
                "cases": [{**self.case, "split": "held-out"}],
            })
            with patch.object(study, "run") as run, self.assertRaisesRegex(ValueError, "Held-out"):
                study.decode(folder, "absent-engine", "absent-model", ["example"])
            run.assert_not_called()

    def test_changed_input_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "source"
            path.write_text("old")
            manifest = {"inputs": {str(path): study.sha256(path)}}
            study.verify_inputs(manifest)
            path.write_text("new")
            with self.assertRaisesRegex(ValueError, "changed"):
                study.verify_inputs(manifest)

    def test_labels_validate_identity_and_completeness_without_printing_held_out_text(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            study.write_json(root / "study.json", {"studyId": "digest", "cases": [self.case]})
            labels = {"version": 1, "studyId": "digest", "cases": [{
                "id": "example", "spoken": "private label", "audibility": "clear",
                "scriptMatchesAudio": "no"}]}
            path = root / "labels.json"
            study.write_json(path, labels)
            self.assertNotIn("private label", study.validate_labels(root, path))
            for patch_value in [{"studyId": "other"}, {"cases": []},
                                {"cases": labels["cases"] * 2}]:
                study.write_json(path, {**labels, **patch_value})
                with self.assertRaises(ValueError):
                    study.validate_labels(root, path)

    def test_decoding_separates_unprompted_evidence_from_conditioned_output(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            audio = root / "example.wav"
            engine, model = root / "engine", root / "model"
            for path in (audio, engine, model):
                path.write_bytes(b"synthetic test input")
            study.write_json(root / "study.json", {
                "policy": study.POLICY, "status": "ready", "studyId": "digest", "inputs": {},
                "cases": [{**self.case, "audioSha256": study.sha256(audio)}]})
            calls = []
            def fake_decode(args, log):
                calls.append(args)
                prefix = Path(args[args.index("-of") + 1])
                study.write_json(prefix.with_suffix(".json"), {
                    "transcription": [{"text": "Decoded from synthetic provider"}]})
            with patch.object(study, "run", side_effect=fake_decode):
                result_path = study.decode(root, engine, model, ["example"])
            result = study.read_json(result_path)
            self.assertEqual(result["status"], "complete")
            self.assertEqual([r["mode"] for r in result["results"]],
                             ["unprompted", "script", "adversarial"])
            self.assertNotIn("--prompt", calls[0])
            self.assertIn("--prompt", calls[1])
            self.assertIn("--prompt", calls[2])
            self.assertNotEqual(calls[1][-1], calls[2][-1])
            for row in result["results"]:
                self.assertGreaterEqual(row["elapsedSeconds"], 0)
                self.assertGreaterEqual(row["childPeakMemoryBytes"], 0)

    def test_decode_cancellation_retains_failed_diagnostics(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            audio, engine, model = root / "example.wav", root / "engine", root / "model"
            for path in (audio, engine, model):
                path.write_bytes(b"test input")
            study.write_json(root / "study.json", {
                "policy": study.POLICY, "status": "ready", "studyId": "digest", "inputs": {},
                "cases": [{**self.case, "audioSha256": study.sha256(audio)}]})
            with patch.object(study, "run", side_effect=KeyboardInterrupt):
                with self.assertRaises(KeyboardInterrupt):
                    study.decode(root, engine, model, ["example"])
            runs = list(root.glob("decodes-*/run.json"))
            self.assertEqual(len(runs), 1)
            self.assertEqual(study.read_json(runs[0])["status"], "failed")

    def test_prepare_is_read_only_and_never_overwrites_studies(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "source.scribe"
            source.mkdir()
            media, script = root / "source.mp4", root / "source.md"
            media.write_bytes(b"private video")
            script.write_text("# Unspoken\nhello", encoding="utf-8")
            project = self.project
            project["media"]["m"]["path"] = str(media)
            project_path = source / "project.json"
            study.write_json(project_path, project)
            original = project_path.read_bytes()
            config = root / "config.json"
            study.write_json(config, {"version": 1, "cases": [
                {**self.case, "project": str(source), "script": str(script)}]})
            def fake_extract(args, log):
                Path(args[-1]).write_bytes(b"fake wav")
            with patch.object(study, "run", side_effect=fake_extract):
                page = study.prepare(config, root / "output", media)
                self.assertTrue(page.exists())
                self.assertEqual(project_path.read_bytes(), original)
                self.assertEqual(study.read_json(page.parent / "study.json")["status"], "ready")
                copy = study.read_json(page.parent / "review-project-1.scribe/project.json")
                self.assertTrue(copy["id"].startswith("study-"))
                self.assertEqual(copy["segments"], project["segments"])
                with self.assertRaises(FileExistsError):
                    study.prepare(config, root / "output", media)
                with self.assertRaisesRegex(ValueError, "separate"):
                    study.prepare(config, source / "bad-output", media)

    def test_failure_records_no_ready_study(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            project = self.project
            media, script, project_path = root / "media", root / "script", root / "project.json"
            media.write_bytes(b"media")
            script.write_text("hello")
            project["media"]["m"]["path"] = str(media)
            study.write_json(project_path, project)
            config = root / "config"
            study.write_json(config, {"version": 1, "cases": [
                {**self.case, "project": str(project_path), "script": str(script)}]})
            # Output must not be inside the project bundle's parent.
            output = root.parent / (root.name + "-output")
            try:
                with patch.object(study, "run", side_effect=OSError("missing audio")):
                    with self.assertRaises(OSError):
                        study.prepare(config, output, media)
                self.assertEqual(study.read_json(output / "study.json")["status"], "failed")
                self.assertFalse((output / "listen.html").exists())
            finally:
                import shutil
                shutil.rmtree(output, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
