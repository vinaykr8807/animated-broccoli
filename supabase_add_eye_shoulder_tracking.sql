-- =====================================================
-- ADD EYE TRACKING AND SHOULDER MOVEMENT VIOLATIONS
-- =====================================================

-- Step 1: Drop the existing constraint FIRST (so we can update data if needed)
ALTER TABLE public.violations
DROP CONSTRAINT IF EXISTS violations_violation_type_check;

-- Step 2: Check what violation types currently exist and update any invalid ones
DO $$
DECLARE
    invalid_types TEXT[];
    invalid_count INTEGER;
BEGIN
    -- Find violation types that are not in our allowed list
    SELECT ARRAY_AGG(DISTINCT violation_type)
    INTO invalid_types
    FROM public.violations
    WHERE violation_type NOT IN (
        'looking_away', 
        'gaze_away',
        'multiple_faces', 
        'multiple_person',
        'no_person', 
        'no_face',
        'phone_detected', 
        'phone',
        'book_detected',
        'object_detected',
        'object',
        'tab_switch', 
        'copy_paste', 
        'excessive_noise',
        'audio_violation',
        'audio_noise',
        'eye_movement',
        'shoulder_movement',
        'window_blur'
    );
    
    -- Get count of invalid types
    IF invalid_types IS NOT NULL THEN
        invalid_count := array_length(invalid_types, 1);
    ELSE
        invalid_count := 0;
    END IF;
    
    -- If there are invalid types, update them to a default valid type
    IF invalid_count > 0 THEN
        RAISE NOTICE 'Found % invalid violation type(s): %', invalid_count, invalid_types;
        -- Update invalid types to 'looking_away' as a safe default
        -- You can change this to another valid type if preferred
        UPDATE public.violations
        SET violation_type = 'looking_away'
        WHERE violation_type = ANY(invalid_types);
        
        RAISE NOTICE 'Updated invalid violation types to "looking_away"';
    ELSE
        RAISE NOTICE 'All existing violation types are valid. No updates needed.';
    END IF;
END $$;

-- Step 3: Add the new constraint with all allowed violation types (including new ones)
ALTER TABLE public.violations
ADD CONSTRAINT violations_violation_type_check 
CHECK (violation_type IN (
  'looking_away', 
  'gaze_away',
  'multiple_faces', 
  'multiple_person',
  'no_person', 
  'no_face',
  'phone_detected', 
  'phone',
  'book_detected',
  'object_detected',
  'object',
  'tab_switch', 
  'copy_paste', 
  'excessive_noise',
  'audio_violation',
  'audio_noise',
  'eye_movement',
  'shoulder_movement',
  'window_blur'
));

-- Add comment for documentation
COMMENT ON COLUMN public.violations.violation_type IS 'Type of violation including eye_movement and shoulder_movement';

-- =====================================================
-- MIGRATION COMPLETE
-- =====================================================
-- Summary:
-- 1. Checked for and updated any invalid violation types in existing data
-- 2. Added 'eye_movement' and 'shoulder_movement' to violation types
-- 3. Updated constraint to allow new violation types

SELECT 'Eye and shoulder tracking violations added successfully!' AS status;

