"""Protocol validation tests that do not load MLX or require pytest."""
import unittest

from mlx_llm.retakes import validate_result, validate_decision


class RetakeValidationTests(unittest.TestCase):
    def group(self):
        return {"kind": "spoken-correction", "attempts": [
            {"start": 1, "end": 2, "complete": True},
            {"start": 3, "end": 4, "complete": True},
        ], "markers": [{"start": 2, "end": 3}]}

    def test_decision_cannot_supply_spans_or_nonbooleans(self):
        for value in [{"retake": True}, {"retake": True, "firstComplete": True, "lastComplete": "yes"}, {"retake": True, "firstComplete": True, "lastComplete": True, "start": 0}]:
            with self.assertRaises(ValueError):
                validate_decision(value)

    def test_valid_and_empty(self):
        self.assertEqual(validate_result([], 4), [])
        self.assertEqual(validate_result([self.group()], 4), [self.group()])

    def test_rejects_unknown_fields_indices_and_overlap(self):
        for mutate in [
            lambda g: g.update(kind="invented"),
            lambda g: g.update(timestamp=1),
            lambda g: g["attempts"][0].update(start=-1),
            lambda g: g["attempts"][0].update(end=10),
            lambda g: g["attempts"][0].update(start=True),
            lambda g: g["attempts"][0].update(complete="yes"),
            lambda g: g["markers"][0].update(start=1),
        ]:
            with self.subTest(mutate=mutate):
                group = self.group()
                mutate(group)
                with self.assertRaises(ValueError):
                    validate_result([group], 4)


if __name__ == "__main__":
    unittest.main()
