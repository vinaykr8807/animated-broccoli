#!/usr/bin/env python3
"""
Test script to verify all the fixes are working properly
"""

import sys
import os
sys.path.append(os.path.join(os.path.dirname(__file__), 'backend'))

from proctoring_service import ProctoringService
import cv2
import numpy as np
import time

def test_black_screen_detection():
    """Test that black screens don't trigger false no-person violations"""
    print("Testing black screen detection...")
    
    service = ProctoringService()
    
    # Create a black frame
    black_frame = np.zeros((480, 640, 3), dtype=np.uint8)
    
    result = service.process_frame(black_frame, "test_session", 0.0, 0.0)
    
    # Should not have no_person violation for black screen
    no_person_violations = [v for v in result['violations'] if v['type'] == 'no_person']
    
    if len(no_person_violations) == 0:
        print("✅ Black screen detection working correctly - no false no-person violation")
    else:
        print("❌ Black screen detection failed - false no-person violation detected")
    
    return len(no_person_violations) == 0

def test_violation_throttling():
    """Test that duplicate violations are throttled"""
    print("Testing violation throttling...")
    
    service = ProctoringService()
    
    # Create a frame with no person
    empty_frame = np.ones((480, 640, 3), dtype=np.uint8) * 50  # Dim but not black
    
    # Process same frame multiple times quickly
    violations_count = []
    for i in range(5):
        result = service.process_frame(empty_frame, "throttle_test", 0.0, 0.0)
        violations_count.append(len(result['violations']))
        time.sleep(0.1)  # Small delay
    
    # First call should have violations, subsequent calls should be throttled
    if violations_count[0] > 0 and all(count == 0 for count in violations_count[1:]):
        print("✅ Violation throttling working correctly")
        return True
    else:
        print(f"❌ Violation throttling failed - violation counts: {violations_count}")
        return False

def test_looking_away_strictness():
    """Test that looking away detection is very strict"""
    print("Testing looking away strictness...")
    
    service = ProctoringService()
    
    # Test with small head movements (should not trigger)
    small_pitch_offset = 10  # Small movement
    small_yaw_offset = 15    # Small movement
    
    is_looking_away, confidence = service.is_looking_away(
        small_pitch_offset, small_yaw_offset, 0.0, 0.0
    )
    
    if not is_looking_away:
        print("✅ Looking away detection is appropriately strict - small movements ignored")
        return True
    else:
        print(f"❌ Looking away detection too sensitive - triggered on small movement (confidence: {confidence})")
        return False

def main():
    """Run all tests"""
    print("🧪 Running comprehensive fix tests...\n")
    
    tests = [
        test_black_screen_detection,
        test_violation_throttling,
        test_looking_away_strictness
    ]
    
    results = []
    for test in tests:
        try:
            result = test()
            results.append(result)
        except Exception as e:
            print(f"❌ Test {test.__name__} failed with error: {e}")
            results.append(False)
        print()
    
    # Summary
    passed = sum(results)
    total = len(results)
    
    print(f"📊 Test Results: {passed}/{total} tests passed")
    
    if passed == total:
        print("🎉 All fixes are working correctly!")
    else:
        print("⚠️  Some issues remain - check the failed tests above")
    
    return passed == total

if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)