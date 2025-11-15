#!/usr/bin/env python3
"""
Test script to verify violation detection and database operations
"""
import sys
import os
sys.path.append(os.path.join(os.path.dirname(__file__), 'backend'))

from supabase import create_client, Client
from dotenv import load_dotenv
import uuid
from datetime import datetime

# Load environment variables
load_dotenv('backend/.env')

def test_violation_insertion():
    """Test inserting violations into the database"""
    
    # Initialize Supabase client
    supabase_url = os.environ.get("SUPABASE_URL", "https://ukwnvvuqmiqrjlghgxnf.supabase.co")
    supabase_key = os.environ.get("SUPABASE_KEY", "")
    
    if not supabase_key:
        print("❌ SUPABASE_KEY not found in environment variables")
        return False
    
    supabase: Client = create_client(supabase_url, supabase_key)
    
    # Test violation types
    test_violations = [
        {
            "violation_type": "tab_switch",
            "severity": "medium",
            "message": "Student switched browser tab"
        },
        {
            "violation_type": "looking_away",
            "severity": "high", 
            "message": "Student looking away from camera"
        },
        {
            "violation_type": "phone_detected",
            "severity": "high",
            "message": "Mobile phone detected in frame"
        },
        {
            "violation_type": "multiple_faces",
            "severity": "high",
            "message": "Multiple people detected"
        },
        {
            "violation_type": "eye_movement",
            "severity": "medium",
            "message": "Excessive eye movement detected"
        },
        {
            "violation_type": "shoulder_movement", 
            "severity": "medium",
            "message": "Continuous shoulder movement detected"
        }
    ]
    
    print("🧪 Testing violation insertion...")
    
    for i, violation in enumerate(test_violations):
        try:
            violation_record = {
                "id": str(uuid.uuid4()),
                "exam_id": None,  # Test with NULL exam_id
                "student_id": None,  # Test with NULL student_id
                "violation_type": violation["violation_type"],
                "severity": violation["severity"],
                "details": {
                    "message": violation["message"],
                    "confidence": 0.85,
                    "session_id": "test_session",
                    "student_name": f"Test Student {i+1}",
                    "student_id": f"TEST{i+1:03d}",
                    "subject_code": "TEST101",
                    "subject_name": "Test Subject",
                },
                "image_url": None,
                "timestamp": datetime.utcnow().isoformat()
            }
            
            result = supabase.table('violations').insert(violation_record).execute()
            print(f"✅ Inserted {violation['violation_type']} violation")
            
        except Exception as e:
            print(f"❌ Failed to insert {violation['violation_type']}: {e}")
            return False
    
    # Test fetching violations
    try:
        result = supabase.table('violations').select('*').limit(10).execute()
        violations = result.data
        print(f"\n📊 Found {len(violations)} violations in database")
        
        violation_types = set(v['violation_type'] for v in violations)
        print(f"📋 Violation types in database: {sorted(violation_types)}")
        
        # Show sample violation
        if violations:
            sample = violations[0]
            print(f"\n📄 Sample violation:")
            print(f"   Type: {sample['violation_type']}")
            print(f"   Severity: {sample['severity']}")
            print(f"   Student: {sample['details'].get('student_name', 'N/A')}")
            print(f"   Subject: {sample['details'].get('subject_name', 'N/A')}")
            print(f"   Has Evidence: {'Yes' if sample['image_url'] else 'No'}")
        
        return True
        
    except Exception as e:
        print(f"❌ Failed to fetch violations: {e}")
        return False

def test_violation_types_constraint():
    """Test that all violation types are allowed by database constraint"""
    
    supabase_url = os.environ.get("SUPABASE_URL", "https://ukwnvvuqmiqrjlghgxnf.supabase.co")
    supabase_key = os.environ.get("SUPABASE_KEY", "")
    supabase: Client = create_client(supabase_url, supabase_key)
    
    # All violation types that should be allowed
    allowed_types = [
        'looking_away', 'gaze_away', 'multiple_faces', 'multiple_person',
        'no_person', 'no_face', 'phone_detected', 'phone', 'book_detected',
        'object_detected', 'object', 'tab_switch', 'copy_paste', 
        'excessive_noise', 'audio_violation', 'audio_noise',
        'eye_movement', 'shoulder_movement', 'window_blur'
    ]
    
    print(f"\n🔍 Testing {len(allowed_types)} violation types...")
    
    failed_types = []
    
    for violation_type in allowed_types:
        try:
            test_record = {
                "id": str(uuid.uuid4()),
                "violation_type": violation_type,
                "severity": "medium",
                "details": {"message": f"Test {violation_type}"},
                "timestamp": datetime.utcnow().isoformat()
            }
            
            # Try to insert
            result = supabase.table('violations').insert(test_record).execute()
            print(f"✅ {violation_type}")
            
            # Clean up - delete the test record
            supabase.table('violations').delete().eq('id', test_record['id']).execute()
            
        except Exception as e:
            print(f"❌ {violation_type}: {e}")
            failed_types.append(violation_type)
    
    if failed_types:
        print(f"\n⚠️ Failed violation types: {failed_types}")
        return False
    else:
        print(f"\n✅ All {len(allowed_types)} violation types are allowed!")
        return True

if __name__ == "__main__":
    print("🚀 Starting violation detection tests...\n")
    
    # Test 1: Violation insertion
    test1_passed = test_violation_insertion()
    
    # Test 2: Violation types constraint
    test2_passed = test_violation_types_constraint()
    
    print(f"\n📊 Test Results:")
    print(f"   Violation Insertion: {'✅ PASSED' if test1_passed else '❌ FAILED'}")
    print(f"   Violation Types: {'✅ PASSED' if test2_passed else '❌ FAILED'}")
    
    if test1_passed and test2_passed:
        print(f"\n🎉 All tests passed! Violation detection should be working properly.")
    else:
        print(f"\n⚠️ Some tests failed. Check the database schema and configuration.")