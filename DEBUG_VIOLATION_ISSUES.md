# Debug Guide: Violation Detection & PDF Generation Issues

## Issues Identified

1. **Only tab switch violations detected** - Other violation types not triggering
2. **PDF generation fails** - Student ID and subject name missing
3. **Evidence images not showing** - File bucket/evidence display issues
4. **Incomplete violation data** - Missing student/subject information

## Root Cause Analysis

### 1. Backend Violation Detection Issues

**Problem**: Only `tab_switch` violations are being detected, missing:
- `looking_away` (head pose detection)
- `phone_detected` (YOLO object detection) 
- `multiple_faces` (face detection)
- `eye_movement` (eye tracking)
- `shoulder_movement` (body movement)
- `excessive_noise` (audio violations)

**Potential Causes**:
- YOLO model not loading properly
- MediaPipe face detection thresholds too strict
- Violation throttling preventing detection
- Frame processing errors

### 2. Database Schema Issues

**Problem**: Violation types may not be properly configured in database constraints.

**Check**: Run the SQL migration to ensure all violation types are allowed:
```sql
-- Check current violation types
SELECT DISTINCT violation_type, COUNT(*) 
FROM violations 
GROUP BY violation_type 
ORDER BY COUNT(*) DESC;
```

### 3. Frontend Data Fetching Issues

**Problem**: StudentReport may not be fetching all violations due to:
- Missing exam_id or student_id relationships
- Incomplete violation queries
- Data transformation issues

## Step-by-Step Debugging Process

### Step 1: Test Database Schema

```bash
cd backend
python ../test_violation_detection.py
```

This will:
- Test all violation types can be inserted
- Verify database constraints
- Check data retrieval

### Step 2: Check Backend Logs

Start the backend server and monitor logs:

```bash
cd backend
python server.py
```

Look for:
- YOLO model loading messages
- MediaPipe initialization
- Violation detection logs
- Database insertion errors

### Step 3: Test Frontend Violation Fetching

Open browser developer tools and check:
- Network requests to `/api/violations`
- Console logs in StudentReport component
- Violation data structure

### Step 4: Verify PDF Generation

Test PDF generation with sample data:
- Check if student ID and subject name are passed correctly
- Verify violation data structure
- Test CSV export functionality

## Quick Fixes Applied

### 1. Enhanced Backend Logging

Added comprehensive logging to `proctoring_service.py`:
- Violation detection messages
- Confidence scores
- Snapshot capture logs

### 2. Improved Data Handling

Fixed `server.py` to ensure complete violation records:
- Always include student/subject information
- Handle NULL values gracefully
- Add additional violation details

### 3. Enhanced PDF Generation

Updated `pdfGenerator.ts`:
- Always show student ID (even if "Not Available")
- Always show subject information
- Better violation type handling
- Enhanced evidence display

### 4. Comprehensive Violation Fetching

Updated `StudentReport.tsx`:
- Multiple strategies to fetch violations
- Search by exam_id, student_id, and student_name
- Better error handling
- Enhanced debugging logs

## Testing Checklist

### Backend Testing
- [ ] YOLO model loads successfully
- [ ] MediaPipe face detection works
- [ ] All violation types can be triggered
- [ ] Violations saved to database with complete data
- [ ] Evidence images uploaded to Supabase storage

### Frontend Testing  
- [ ] All violation types display in AdminDashboard
- [ ] StudentReport shows all violations
- [ ] PDF generation includes all data
- [ ] CSV export contains complete information
- [ ] Evidence images display properly

### Database Testing
- [ ] All violation types allowed by constraints
- [ ] Violations have proper student/exam relationships
- [ ] Evidence URLs are accessible
- [ ] Data integrity maintained

## Common Issues & Solutions

### Issue: "YOLO model not loading"
**Solution**: 
```bash
cd backend
python download_model.py
```

### Issue: "No violations detected"
**Solution**: Check calibration values and thresholds in `proctoring_service.py`

### Issue: "PDF shows 'Not Available' for student data"
**Solution**: Verify violation details contain student information

### Issue: "Evidence images not loading"
**Solution**: Check Supabase storage bucket permissions and URLs

## Verification Commands

### Check Database Violations
```sql
SELECT 
  violation_type,
  COUNT(*) as count,
  COUNT(CASE WHEN image_url IS NOT NULL THEN 1 END) as with_evidence,
  COUNT(CASE WHEN details->>'student_name' IS NOT NULL THEN 1 END) as with_student_info
FROM violations 
GROUP BY violation_type 
ORDER BY count DESC;
```

### Test Backend API
```bash
curl -X GET "http://localhost:8001/api/violations" | jq
```

### Check Frontend Console
Open browser dev tools and look for:
- Violation fetch logs
- PDF generation logs  
- Error messages

## Expected Results After Fixes

1. **All violation types detected**: looking_away, phone_detected, multiple_faces, etc.
2. **Complete PDF reports**: Student ID, subject name, all violations with evidence
3. **Proper evidence display**: Images show in reports and can be clicked to enlarge
4. **Accurate CSV exports**: All violation data with student/subject information
5. **Real-time detection**: Violations appear immediately in AdminDashboard

## Next Steps

1. Run the test script to verify database schema
2. Start backend server and test violation detection
3. Test frontend components with sample data
4. Generate PDF reports and verify content
5. Check evidence image display and accessibility

If issues persist, check the specific error messages in browser console and backend logs for more targeted debugging.