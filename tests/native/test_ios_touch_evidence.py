import copy
import unittest
from ios_touch_evidence import validate_two_paths, validate_short_stroke

class TouchEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.bounds = {"x": 24, "y": 206, "width": 169, "height": 312}
        def path(x, change, identity):
            return {"pathType": 1, "index": identity, "pointerEvents": [
                {"eventType": 1, "coordinate.x": x, "coordinate.y": 300, "offset": 0},
                {"eventType": 2, "coordinate.x": x + change, "coordinate.y": 310, "offset": 0.2},
                {"eventType": 3, "coordinate.x": x + change, "coordinate.y": 310, "offset": 0.3}]}
        self.record = {"eventPaths": [path(80, 5, 1), path(130, -5, 2)]}
    def test_accepts_two_overlapping_real_paths(self):
        self.assertEqual(validate_two_paths(self.record, self.bounds)["simultaneousTouchCount"], 2)
    def test_rejects_one_finger_or_touch_outside_card(self):
        single = copy.deepcopy(self.record); single["eventPaths"].pop()
        with self.assertRaises(ValueError): validate_two_paths(single, self.bounds)
        outside = copy.deepcopy(self.record); outside["eventPaths"][1]["pointerEvents"][0]["coordinate.x"] = 220
        with self.assertRaises(ValueError): validate_two_paths(outside, self.bounds)
    def test_rejects_nonoverlapping_or_incomplete_paths(self):
        delayed = copy.deepcopy(self.record)
        for event in delayed["eventPaths"][1]["pointerEvents"]: event["offset"] += 1
        with self.assertRaises(ValueError): validate_two_paths(delayed, self.bounds)
        incomplete = copy.deepcopy(self.record); incomplete["eventPaths"][1]["pointerEvents"].pop()
        with self.assertRaises(ValueError): validate_two_paths(incomplete, self.bounds)

    def test_rejects_duplicate_or_stationary_paths(self):
        duplicate = copy.deepcopy(self.record); duplicate["eventPaths"][1] = copy.deepcopy(duplicate["eventPaths"][0])
        with self.assertRaises(ValueError): validate_two_paths(duplicate, self.bounds)
        stationary = copy.deepcopy(self.record)
        for path in stationary["eventPaths"]:
            for event in path["pointerEvents"]:
                event["coordinate.x"] = path["pointerEvents"][0]["coordinate.x"]
                event["coordinate.y"] = path["pointerEvents"][0]["coordinate.y"]
        with self.assertRaises(ValueError): validate_two_paths(stationary, self.bounds)

class ShortStrokeTests(unittest.TestCase):
    def setUp(self):
        self.stimulus = {"start": {"x":108.5, "y":393.2}, "end": {"x":108.5, "y":373.2}}
        self.record = {"eventPaths": [{"pathType":1, "pointerEvents": [
            {"eventType":kind,"coordinate.x":108.5,"coordinate.y":393.2-dy,"offset":offset}
            for kind,dy,offset in [(1,0,0),(2,20,.0133333333333333),(3,20,.0133333333333333)]
        ]}]}
    def test_accepts_real_xctest_endpoint_move_and_coincident_up(self):
        self.assertEqual(validate_short_stroke(self.record,self.stimulus)["upwardTravel"],20)
    def test_rejects_overshoot_or_reversal(self):
        overshoot = copy.deepcopy(self.record)
        overshoot["eventPaths"][0]["pointerEvents"].insert(1,{"eventType":2,"coordinate.x":108.5,"coordinate.y":350,"offset":.005})
        with self.assertRaises(ValueError): validate_short_stroke(overshoot,self.stimulus)
    def test_rejects_incomplete_path_or_wrong_endpoint(self):
        incomplete = copy.deepcopy(self.record);incomplete["eventPaths"][0]["pointerEvents"].pop(1)
        with self.assertRaises(ValueError): validate_short_stroke(incomplete,self.stimulus)
        wrong = copy.deepcopy(self.stimulus);wrong["end"]["y"] +=1
        with self.assertRaises(ValueError): validate_short_stroke(self.record,wrong)

if __name__ == '__main__': unittest.main()
