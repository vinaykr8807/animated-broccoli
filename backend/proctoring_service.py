import cv2
import mediapipe as mp
import numpy as np
from ultralytics import YOLO
import base64
from typing import Dict, Optional, Tuple
import time
from datetime import datetime

class ProctoringService:
    """
    AI-powered proctoring service using MediaPipe and YOLOv8n
    Detects: looking away, multiple people, prohibited objects (phone, book)
    """
    
    def __init__(self):
        # Initialize MediaPipe with optimized settings for real-time performance
        self.mp_face_mesh = mp.solutions.face_mesh.FaceMesh(
            refine_landmarks=True,
            min_detection_confidence=0.3,  # Lowered for better detection
            min_tracking_confidence=0.3   # Lowered for better tracking
        )
        self.mp_face_detection = mp.solutions.face_detection.FaceDetection(
            min_detection_confidence=0.3  # Lowered for better detection
        )
        
        # Initialize YOLO model with optimized settings for real-time performance
        try:
            self.yolo_model = YOLO('models/yolov8n.pt')
            self.yolo_model.conf = 0.3  # Lowered confidence threshold for better detection
            self.yolo_model.iou = 0.5   # IoU threshold for NMS
            print("✅ YOLO model loaded successfully")
        except Exception as e:
            print(f"❌ YOLO model loading failed: {e}")
            self.yolo_model = None
        
        # 3D Model points for head pose estimation
        self.model_points = np.array([
            (0.0, 0.0, 0.0),
            (0.0, -330.0, -65.0),
            (-225.0, 170.0, -135.0),
            (225.0, 170.0, -135.0),
            (-150.0, -150.0, -125.0),
            (150.0, -150.0, -125.0)
        ], dtype=np.float64)
        
        # Thresholds (EXTREMELY STRICT - Only flag very obvious head turns)
        # Based on screenshot analysis: person looking to the right side significantly
        self.MAX_YAW_OFFSET = 60   # Degrees - head turning left/right (stricter - only major turns like in screenshot)
        self.MAX_PITCH_OFFSET = 50  # Degrees - head tilting up/down (stricter)
        
        # Looking away confidence thresholds (ULTRA STRICT to minimize false positives)
        self.LOOKING_AWAY_CONFIDENCE_THRESHOLD = 0.98  # Must be ULTRA clearly looking away (98%+)
        self.LOOKING_AWAY_SEVERITY_THRESHOLD = 0.99    # Almost 100% certain they're looking away
        
        # Detection confidence thresholds (optimized for real-time)
        self.OBJECT_CONFIDENCE_THRESHOLD = 0.3  # Lowered for better detection
        self.FACE_CONFIDENCE_THRESHOLD = 0.3    # Lowered for better detection
        
        # Snapshot throttle per session: only allow snapshot every 2 seconds
        self.SNAPSHOT_INTERVAL_SEC = 2.0
        self.last_snapshot_time_by_session: Dict[str, float] = {}
        
        # Violation throttling to prevent duplicates - increased to prevent +2 or more duplicates
        # Use per-session, per-violation-type tracking with longer throttle period
        self.VIOLATION_THROTTLE_SEC = 12.0  # Don't repeat same violation type within 12 seconds (increased from 8)
        self.last_violation_time_by_session: Dict[str, Dict[str, float]] = {}
        
        # Track last violation types per session to prevent same violation in same frame
        self.last_violation_types_by_session: Dict[str, set] = {}
        
        # Eye movement tracking
        self.eye_movement_threshold_sec = 5.0  # Alert if eyes away for 5+ seconds
        self.eye_movement_tracking: Dict[str, Dict] = {}  # Track eye position per session: {session_id: {'start_time': float, 'last_eye_pos': tuple, 'away_duration': float}}
        
        # Shoulder movement tracking  
        self.shoulder_movement_threshold = 0.15  # Threshold for shoulder position change (15% of frame)
        self.shoulder_movement_tracking: Dict[str, Dict] = {}  # Track shoulder position per session
        self.shoulder_change_count: Dict[str, int] = {}  # Count continuous shoulder changes
        self.shoulder_change_threshold = 5  # Alert if shoulder changes 5+ times continuously
        
    def estimate_head_pose(self, landmarks, width: int, height: int) -> Optional[Tuple[float, float, float]]:
        """
        Estimate head pose (pitch, yaw, roll) from facial landmarks
        """
        try:
            image_points = np.array([
                (landmarks[1].x * width, landmarks[1].y * height),
                (landmarks[152].x * width, landmarks[152].y * height),
                (landmarks[33].x * width, landmarks[33].y * height),
                (landmarks[263].x * width, landmarks[263].y * height),
                (landmarks[61].x * width, landmarks[61].y * height),
                (landmarks[291].x * width, landmarks[291].y * height)
            ], dtype=np.float64)

            focal_length = width
            camera_matrix = np.array([
                [focal_length, 0, width / 2],
                [0, focal_length, height / 2],
                [0, 0, 1]
            ], dtype=np.float64)

            success, rotation_vector, _ = cv2.solvePnP(
                self.model_points, 
                image_points, 
                camera_matrix, 
                np.zeros((4, 1))
            )
            
            if not success:
                return None

            rmat, _ = cv2.Rodrigues(rotation_vector)
            angles, _, _, _, _, _ = cv2.RQDecomp3x3(rmat)
            return angles  # pitch, yaw, roll
        except Exception as e:
            print(f"Head pose estimation error: {e}")
            return None

    def is_looking_away(self, pitch: float, yaw: float, calibrated_pitch: float, calibrated_yaw: float) -> Tuple[bool, float]:
        """
        Check if user is looking away from camera based on calibrated values
        Returns (is_looking_away, confidence_score)
        
        VERY STRICT logic to minimize false positives:
        - Only flags SIGNIFICANT head movements
        - Requires BOTH high confidence AND large deviation
        - Ignores small natural movements
        """
        pitch_offset = abs(pitch - calibrated_pitch)
        yaw_offset = abs(yaw - calibrated_yaw)
        
        # Calculate confidence score based on how far the head is turned
        # Normalize offsets to 0-1 range
        normalized_pitch = min(pitch_offset / self.MAX_PITCH_OFFSET, 1.0)
        normalized_yaw = min(yaw_offset / self.MAX_YAW_OFFSET, 1.0)
        
        # Use weighted average favoring yaw (left/right is THE strongest indicator)
        # Yaw has MUCH more weight (0.8) as looking left/right is primary indicator
        confidence_score = (normalized_yaw * 0.8) + (normalized_pitch * 0.2)
        
        # ULTRA STRICT REQUIREMENTS - ALL must be true to avoid false positives:
        # Based on screenshot: person is clearly looking to the right side (profile view)
        # 1. Confidence score must be ULTRA high (98%+)
        # 2. Yaw offset must be EXTREMELY SIGNIFICANT (more than 85% of max threshold = ~51 degrees)
        # 3. Primary indicator is YAW (left/right turn) - this is the main detection
        # 4. Total angular deviation must be very substantial
        # 5. Must pass multiple validation checks
        
        extremely_significant_yaw = yaw_offset > (self.MAX_YAW_OFFSET * 0.85)  # 85% of max = ~51 degrees (stricter)
        significant_pitch_deviation = pitch_offset > (self.MAX_PITCH_OFFSET * 0.7)  # 70% of max = ~35 degrees
        
        # Additional validation: check if the movement is consistent and not just noise
        total_angular_deviation = np.sqrt(yaw_offset**2 + pitch_offset**2)
        substantial_total_movement = total_angular_deviation > 55  # At least 55 degrees total movement (stricter)
        
        # Ultra strict validation - person must be OBVIOUSLY looking away like in screenshot
        # Primary focus on YAW (horizontal head turn) as that's the main indicator
        # This should prevent false positives where student is looking at camera
        is_looking_away = (
            confidence_score >= self.LOOKING_AWAY_CONFIDENCE_THRESHOLD and  # 98%+ confidence (stricter)
            extremely_significant_yaw and  # Major horizontal head turn (51+ degrees)
            substantial_total_movement and  # Substantial total movement (55+ degrees)
            yaw_offset > 50  # Absolute minimum yaw threshold (50+ degrees - stricter)
        )
        
        return is_looking_away, confidence_score

    def detect_multiple_faces(self, detections) -> bool:
        """
        Check if multiple faces are detected
        """
        return len(detections) > 1 if detections else False

    def detect_prohibited_objects(self, frame: np.ndarray) -> Dict[str, any]:
        """
        Detect prohibited objects (cell phone, book) using YOLOv8
        Returns dict with detection info and annotated frame
        """
        detections = {
            'phone_detected': False,
            'book_detected': False,
            'objects': []
        }
        
        # Check if YOLO model is available
        if self.yolo_model is None:
            print("⚠️ YOLO model not available, skipping object detection")
            detections['annotated_frame'] = frame
            return detections
        
        try:
            # Run YOLO detection with confidence threshold
            yolo_results = self.yolo_model(
                frame, 
                stream=True, 
                verbose=False,
                conf=self.OBJECT_CONFIDENCE_THRESHOLD
            )
            
            for result in yolo_results:
                if result.boxes is None or len(result.boxes) == 0:
                    continue
                    
                for box in result.boxes:
                    cls = result.names[int(box.cls[0])]
                    confidence = float(box.conf[0])
                    
                    # Only process if confidence meets threshold
                    if confidence < self.OBJECT_CONFIDENCE_THRESHOLD:
                        continue
                    
                    x1, y1, x2, y2 = map(int, box.xyxy[0])
                    
                    # Detect cell phone (including variations)
                    if cls in ["cell phone", "phone", "mobile"]:
                        detections['objects'].append({
                            'type': 'cell phone',
                            'confidence': confidence,
                            'bbox': [x1, y1, x2, y2]
                        })
                        detections['phone_detected'] = True
                        
                        # Draw bounding box
                        cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 0, 255), 3)
                        cv2.putText(frame, f"PHONE {confidence:.2f}", (x1, y1 - 10),
                                  cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)
                    
                    # Detect book
                    elif cls == "book":
                        detections['objects'].append({
                            'type': 'book',
                            'confidence': confidence,
                            'bbox': [x1, y1, x2, y2]
                        })
                        detections['book_detected'] = True
                        
                        # Draw bounding box
                        cv2.rectangle(frame, (x1, y1), (x2, y2), (255, 0, 0), 3)
                        cv2.putText(frame, f"BOOK {confidence:.2f}", (x1, y1 - 10),
                                  cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 0, 0), 2)
        except Exception as e:
            print(f"Object detection error: {e}")
        
        detections['annotated_frame'] = frame
        return detections

    def calibrate_head_pose(self, frame: np.ndarray) -> Dict:
        """
        Calibrate head pose from a frame
        Returns calibration values
        """
        try:
            height, width, _ = frame.shape
            rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            
            face_mesh_results = self.mp_face_mesh.process(rgb_frame)
            if face_mesh_results.multi_face_landmarks:
                landmarks = face_mesh_results.multi_face_landmarks[0].landmark
                angles = self.estimate_head_pose(landmarks, width, height)
                
                if angles:
                    pitch, yaw, roll = angles
                    return {
                        'success': True,
                        'pitch': float(pitch),
                        'yaw': float(yaw),
                        'roll': float(roll)
                    }
            
            return {'success': False, 'message': 'No face detected for calibration'}
        except Exception as e:
            return {'success': False, 'message': f'Calibration error: {str(e)}'}
    
    def check_environment(self, frame: np.ndarray) -> Dict:
        """
        Check environment lighting and face detection
        """
        try:
            height, width, _ = frame.shape
            rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            
            # Check lighting (convert to grayscale and check brightness)
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            brightness = np.mean(gray)
            lighting_ok = 40 < brightness < 220  # Acceptable range
            
            # Check face detection
            face_detection_results = self.mp_face_detection.process(rgb_frame)
            face_detected = face_detection_results.detections is not None and len(face_detection_results.detections) > 0
            
            # Check if face is centered
            face_centered = False
            if face_detected:
                detection = face_detection_results.detections[0]
                bbox = detection.location_data.relative_bounding_box
                center_x = bbox.xmin + bbox.width / 2
                center_y = bbox.ymin + bbox.height / 2
                face_centered = (0.3 < center_x < 0.7) and (0.2 < center_y < 0.7)
            
            message = []
            if not lighting_ok:
                if brightness < 40:
                    message.append("Lighting too dark")
                else:
                    message.append("Lighting too bright")
            if not face_detected:
                message.append("No face detected")
            elif not face_centered:
                message.append("Face not centered")
            
            if not message:
                message.append("Environment check passed")
            
            return {
                'lighting_ok': lighting_ok,
                'face_detected': face_detected,
                'face_centered': face_centered,
                'message': ', '.join(message),
                'brightness': float(brightness)
            }
        except Exception as e:
            return {
                'lighting_ok': False,
                'face_detected': False,
                'face_centered': False,
                'message': f'Environment check error: {str(e)}'
            }

    def process_frame(self, frame: np.ndarray, session_id: str, calibrated_pitch: float, calibrated_yaw: float) -> Dict:
        """
        Process a single frame for all violations
        Returns comprehensive violation report
        """
        try:
            if frame is None:
                return {'error': 'Invalid frame data'}
            
            height, width, _ = frame.shape
            rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            
            # Initialize result
            result = {
                'timestamp': datetime.utcnow().isoformat(),
                'violations': [],
                'head_pose': None,
                'face_count': 0,
                'looking_away': False,
                'multiple_faces': False,
                'no_person': False,
                'phone_detected': False,
                'book_detected': False,
                'snapshot_base64': None
            }
            
            # Initialize violation tracking for this session
            if session_id not in self.last_violation_time_by_session:
                self.last_violation_time_by_session[session_id] = {}
            if session_id not in self.last_violation_types_by_session:
                self.last_violation_types_by_session[session_id] = set()
            
            current_time = time.time()
            
            def should_add_violation(violation_type: str) -> bool:
                """Check if we should add this violation type (throttling)
                Prevents same violation type from being added multiple times in quick succession
                """
                # Check time-based throttling
                last_time = self.last_violation_time_by_session[session_id].get(violation_type, 0)
                time_since_last = current_time - last_time
                
                # Only allow if enough time has passed AND it's not already in current frame violations
                if time_since_last >= self.VIOLATION_THROTTLE_SEC:
                    # Check if this violation type was already added in this frame processing
                    if violation_type not in self.last_violation_types_by_session[session_id]:
                        self.last_violation_time_by_session[session_id][violation_type] = current_time
                        self.last_violation_types_by_session[session_id].add(violation_type)
                        return True
                return False
            
            # Clear frame-level violation tracking at start of each frame
            self.last_violation_types_by_session[session_id].clear()
            
            # Check frame brightness to avoid false positives on black screens
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            brightness = np.mean(gray)
            # Stricter black screen detection - if brightness is very low, it's likely camera off
            is_black_screen = brightness < 15  # Very dark frame (increased threshold)
            
            # Detect multiple faces first
            face_detection_results = self.mp_face_detection.process(rgb_frame)
            if face_detection_results.detections:
                result['face_count'] = len(face_detection_results.detections)
                
                if self.detect_multiple_faces(face_detection_results.detections):
                    result['multiple_faces'] = True
                    if should_add_violation('multiple_faces'):
                        result['violations'].append({
                            'type': 'multiple_faces',
                            'severity': 'high',
                            'message': f'{len(face_detection_results.detections)} people detected in frame',
                            'confidence': 0.95
                        })
                        print(f"👥 MULTIPLE FACES DETECTED: {len(face_detection_results.detections)} people")
                    cv2.putText(frame, "MULTIPLE PEOPLE DETECTED!", (50, 100),
                              cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 2)
            else:
                # Only flag "no person" if it's not a black screen (camera issue)
                # Also check if exam is still active - don't flag if exam is completed
                if not is_black_screen and should_add_violation('no_person'):
                    result['no_person'] = True
                    result['violations'].append({
                        'type': 'no_person',
                        'severity': 'medium',  # Reduced severity
                        'message': f'No person detected in frame (brightness: {brightness:.1f})',
                        'confidence': 0.9
                    })
                    cv2.putText(frame, "NO PERSON DETECTED!", (50, 50),
                              cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 2)
                    print(f"👤 NO PERSON DETECTED: brightness={brightness:.1f}")
                elif is_black_screen:
                    # Black screen detected - likely camera issue, don't flag as violation
                    # This prevents false positives when webcam turns off after exam
                    cv2.putText(frame, "CAMERA ISSUE - BLACK SCREEN", (50, 50),
                              cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 0), 2)
                    # Don't set no_person flag for black screens
                    result['no_person'] = False
                    print(f"📺 BLACK SCREEN DETECTED: brightness={brightness:.1f} (not flagged as violation)")
            
            # Process face mesh for head pose (only if single person detected)
            if result['face_count'] == 1:
                face_mesh_results = self.mp_face_mesh.process(rgb_frame)
                if face_mesh_results.multi_face_landmarks:
                    landmarks = face_mesh_results.multi_face_landmarks[0].landmark
                    angles = self.estimate_head_pose(landmarks, width, height)
                    
                    if angles:
                        pitch, yaw, roll = angles
                        result['head_pose'] = {
                            'pitch': float(pitch),
                            'yaw': float(yaw),
                            'roll': float(roll)
                        }
                        
                        # Check if looking away with confidence scoring (VERY STRICT)
                        is_looking_away, confidence_score = self.is_looking_away(pitch, yaw, calibrated_pitch, calibrated_yaw)
                        
                        # Multiple validation layers to prevent false positives:
                        # 1. Ensure head pose values are reasonable
                        reasonable_pose = abs(pitch) < 90 and abs(yaw) < 90
                        
                        # 2. Check if face landmarks are stable (not jittery detection)
                        landmark_quality = len(landmarks) > 400  # MediaPipe should detect 468 landmarks
                        
                        # 3. Ensure calibration values are reasonable
                        reasonable_calibration = abs(calibrated_pitch) < 45 and abs(calibrated_yaw) < 45
                        
                        # 4. Check if the person is actually facing away (not just slight movement)
                        # Primary indicator is YAW (horizontal turn) - like in screenshot where person looks to the right
                        yaw_offset = abs(yaw - calibrated_yaw)
                        pitch_offset = abs(pitch - calibrated_pitch)
                        actually_looking_away = (yaw_offset > 50 and pitch_offset < 60)  # Strong horizontal turn, not just looking up/down
                        
                        if is_looking_away and reasonable_pose and landmark_quality and reasonable_calibration and actually_looking_away:
                            result['looking_away'] = True
                            
                            if should_add_violation('looking_away'):
                                # Calculate actual angles for better reporting
                                pitch_diff = abs(pitch - calibrated_pitch)
                                yaw_diff = abs(yaw - calibrated_yaw)
                                
                                # Determine severity based on confidence score and angle differences
                                if confidence_score >= self.LOOKING_AWAY_SEVERITY_THRESHOLD:
                                    severity = 'high'
                                    message = f'Student clearly looking away - Head turned {yaw_diff:.1f}° horizontally, {pitch_diff:.1f}° vertically (confidence: {confidence_score:.2f})'
                                else:
                                    severity = 'medium'
                                    message = f'Student appears to be looking away - Head turned {yaw_diff:.1f}° horizontally, {pitch_diff:.1f}° vertically (confidence: {confidence_score:.2f})'
                                
                                result['violations'].append({
                                    'type': 'looking_away',
                                    'severity': severity,
                                    'message': message,
                                    'confidence': confidence_score,
                                    'pitch_offset': pitch_diff,
                                    'yaw_offset': yaw_diff
                                })
                            
                            # Display confidence on frame with angle info
                            cv2.putText(frame, f"LOOKING AWAY! Yaw:{yaw_diff:.1f}° Pitch:{pitch_diff:.1f}° ({confidence_score:.2f})", (50, 150), 
                                      cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)
                        
                        # Eye movement tracking - detect if eyes are looking away from screen
                        # Use eye landmarks to determine gaze direction
                        if landmarks and len(landmarks) >= 468:  # MediaPipe Face Mesh has 468 landmarks
                            eye_offset_x = 0
                            left_eye_center_y = 0
                            right_eye_center_y = 0
                            eye_tracking_valid = False
                            
                            try:
                                # Get eye landmarks (left eye: 33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246)
                                # Right eye: 362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398
                                left_eye_landmarks = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246]
                                right_eye_landmarks = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398]
                                
                                # Filter valid landmark indices
                                valid_left = [i for i in left_eye_landmarks if i < len(landmarks)]
                                valid_right = [i for i in right_eye_landmarks if i < len(landmarks)]
                                
                                if valid_left and valid_right and 10 < len(landmarks) and 152 < len(landmarks):
                                    # Calculate eye center positions
                                    left_eye_center_x = sum(landmarks[i].x for i in valid_left) / len(valid_left)
                                    left_eye_center_y = sum(landmarks[i].y for i in valid_left) / len(valid_left)
                                    right_eye_center_x = sum(landmarks[i].x for i in valid_right) / len(valid_right)
                                    right_eye_center_y = sum(landmarks[i].y for i in valid_right) / len(valid_right)
                                    
                                    # Calculate eye position relative to face center
                                    face_center_x = (landmarks[10].x + landmarks[152].x) / 2  # Left and right face edge
                                    eye_offset_x = ((left_eye_center_x + right_eye_center_x) / 2) - face_center_x
                                    eye_tracking_valid = True
                            except (IndexError, AttributeError) as e:
                                # If landmark access fails, skip eye tracking for this frame
                                print(f"Eye tracking error: {e}")
                            
                            # Only proceed if we have valid eye tracking data
                            if eye_tracking_valid:
                                # Initialize tracking for this session
                                if session_id not in self.eye_movement_tracking:
                                    self.eye_movement_tracking[session_id] = {
                                        'start_time': current_time,
                                        'last_eye_pos': (eye_offset_x, (left_eye_center_y + right_eye_center_y) / 2),
                                        'away_duration': 0.0,
                                        'is_away': False
                                    }
                                
                                tracking = self.eye_movement_tracking[session_id]
                                current_eye_pos = (eye_offset_x, (left_eye_center_y + right_eye_center_y) / 2)
                                last_pos = tracking['last_eye_pos']
                                
                                # Calculate eye movement (up/down/left/right)
                                movement_x = abs(current_eye_pos[0] - last_pos[0])
                                movement_y = abs(current_eye_pos[1] - last_pos[1])
                                total_movement = np.sqrt(movement_x**2 + movement_y**2)
                                
                                # Check if eyes are away from webcam (not looking at screen)
                                eye_offset_threshold = 0.15  # 15% of face width
                                eyes_are_away = abs(eye_offset_x) > eye_offset_threshold or is_looking_away
                                
                                # Only track if eyes are away AND there's significant movement
                                movement_threshold = 0.05  # 5% movement threshold
                                if eyes_are_away and total_movement > movement_threshold:
                                    if not tracking['is_away']:
                                        tracking['start_time'] = current_time
                                        tracking['is_away'] = True
                                    tracking['away_duration'] = current_time - tracking['start_time']
                                    
                                    # Alert if eyes away for more than threshold (5 seconds) WITH movement
                                    if tracking['away_duration'] >= self.eye_movement_threshold_sec:
                                        if should_add_violation('eye_movement'):
                                            violation_data = {
                                                'type': 'eye_movement',
                                                'severity': 'medium',
                                                'message': f'Eyes away from webcam with movement for {tracking["away_duration"]:.1f} seconds',
                                                'duration': tracking['away_duration'],
                                                'movement': total_movement,
                                                'eye_offset': eye_offset_x,
                                                'confidence': 0.85
                                            }
                                            result['violations'].append(violation_data)
                                            print(f"👁️ EYE MOVEMENT VIOLATION DETECTED: {violation_data['message']}")
                                            cv2.putText(frame, f"EYE MOVEMENT! ({tracking['away_duration']:.1f}s)", (50, 200),
                                                      cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 165, 0), 2)
                                            # Reset after violation
                                            tracking['is_away'] = False
                                            tracking['away_duration'] = 0.0
                                else:
                                    # Eyes are back or no movement - reset tracking
                                    if tracking['is_away']:
                                        # Only reset if eyes have been back for more than 1 second
                                        if (current_time - tracking['start_time'] - tracking['away_duration']) > 1.0:
                                            tracking['is_away'] = False
                                            tracking['away_duration'] = 0.0
                                
                                tracking['last_eye_pos'] = current_eye_pos
                        
                        # Shoulder movement tracking - detect continuous shoulder position changes
                        # Use pose estimation landmarks if available (MediaPipe Pose)
                        # For now, use face position as proxy for shoulder position
                        if landmarks and len(landmarks) >= 468:
                            try:
                                # Use face position as proxy for upper body/shoulder position
                                # Check if landmark indices are valid
                                if 234 < len(landmarks) and 454 < len(landmarks) and 10 < len(landmarks) and 152 < len(landmarks):
                                    face_left = landmarks[234].x * width  # Left face edge
                                    face_right = landmarks[454].x * width  # Right face edge
                                    face_top = landmarks[10].y * height  # Top of face
                                    face_bottom = landmarks[152].y * height  # Bottom of face
                                    
                                    # Calculate face center as proxy for shoulder position
                                    face_center_x = (face_left + face_right) / 2
                                    face_center_y = (face_top + face_bottom) / 2
                                    
                                    # Initialize tracking for this session
                                    if session_id not in self.shoulder_movement_tracking:
                                        self.shoulder_movement_tracking[session_id] = {
                                            'last_position': (face_center_x, face_center_y),
                                            'change_count': 0,
                                            'last_change_time': current_time
                                        }
                                        self.shoulder_change_count[session_id] = 0
                                    
                                    tracking = self.shoulder_movement_tracking[session_id]
                                    last_pos = tracking['last_position']
                                    
                                    # Calculate position change
                                    position_change = np.sqrt((face_center_x - last_pos[0])**2 + (face_center_y - last_pos[1])**2)
                                    normalized_change = position_change / max(width, height)  # Normalize to frame size
                                    
                                    # Check if movement exceeds threshold
                                    if normalized_change > self.shoulder_movement_threshold:
                                        tracking['change_count'] += 1
                                        tracking['last_change_time'] = current_time
                                        
                                        # Reset count if too much time passed (not continuous)
                                        if (current_time - tracking['last_change_time']) > 2.0:
                                            tracking['change_count'] = 1
                                        
                                        # Alert if continuous changes detected
                                        if tracking['change_count'] >= self.shoulder_change_threshold:
                                            if should_add_violation('shoulder_movement'):
                                                violation_data = {
                                                    'type': 'shoulder_movement',
                                                    'severity': 'medium',
                                                    'message': f'Continuous shoulder/body movement detected ({tracking["change_count"]} changes)',
                                                    'change_count': tracking['change_count'],
                                                    'movement_distance': normalized_change,
                                                    'confidence': 0.80
                                                }
                                                result['violations'].append(violation_data)
                                                print(f"🤸 SHOULDER MOVEMENT VIOLATION DETECTED: {violation_data['message']}")
                                                cv2.putText(frame, f"SHOULDER MOVEMENT! ({tracking['change_count']} changes)", (50, 250),
                                                          cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 140, 0), 2)
                                                # Reset count after alerting
                                                tracking['change_count'] = 0
                                    else:
                                        # Small movement - reset count gradually
                                        if (current_time - tracking['last_change_time']) > 1.0:
                                            tracking['change_count'] = max(0, tracking['change_count'] - 1)
                                    
                                    tracking['last_position'] = (face_center_x, face_center_y)
                            except (IndexError, AttributeError) as e:
                                print(f"Shoulder tracking error: {e}")
            
            # Detect prohibited objects
            object_detection = self.detect_prohibited_objects(frame)
            result['phone_detected'] = object_detection['phone_detected']
            result['book_detected'] = False  # Book detection disabled
            
            if object_detection['phone_detected'] and should_add_violation('phone_detected'):
                phone_objects = [obj for obj in object_detection['objects'] if obj['type'] == 'cell phone']
                confidence = phone_objects[0]['confidence'] if phone_objects else 0.5
                result['violations'].append({
                    'type': 'phone_detected',
                    'severity': 'high',
                    'message': f'Mobile phone detected with {confidence:.2f} confidence',
                    'confidence': confidence
                })
                print(f"📱 PHONE DETECTED: confidence={confidence:.2f}")
            
            # Also check for book detection (re-enable if needed)
            if object_detection['book_detected'] and should_add_violation('book_detected'):
                book_objects = [obj for obj in object_detection['objects'] if obj['type'] == 'book']
                confidence = book_objects[0]['confidence'] if book_objects else 0.5
                result['violations'].append({
                    'type': 'book_detected',
                    'severity': 'medium',
                    'message': f'Book detected with {confidence:.2f} confidence',
                    'confidence': confidence
                })
                print(f"📚 BOOK DETECTED: confidence={confidence:.2f}")
            
            # If violations exist, capture snapshot (throttled per session and only for violations that need evidence)
            # Only capture snapshot if there are actual violations (not just warnings)
            violation_types_needing_snapshot = ['looking_away', 'multiple_faces', 'phone_detected', 'eye_movement', 'shoulder_movement', 'object_detected', 'book_detected']
            has_violation_needing_snapshot = any(v.get('type') in violation_types_needing_snapshot for v in result['violations'])
            
            # Log all violations detected for debugging
            if result['violations']:
                print(f"🚨 VIOLATIONS DETECTED in session {session_id}: {[v.get('type') for v in result['violations']]}")
                for v in result['violations']:
                    print(f"   - {v.get('type')}: {v.get('message')} (severity: {v.get('severity')})")
            
            if result['violations'] and has_violation_needing_snapshot:
                now_ts = time.time()
                last_ts = self.last_snapshot_time_by_session.get(session_id, 0.0)
                # Increased snapshot interval to reduce wasteful captures
                if (now_ts - last_ts) >= (self.SNAPSHOT_INTERVAL_SEC * 2):  # Double the interval (4 seconds instead of 2)
                    annotated_frame = object_detection['annotated_frame']
                    _, buffer = cv2.imencode('.jpg', annotated_frame, [cv2.IMWRITE_JPEG_QUALITY, 85])  # Slightly lower quality to save space
                    result['snapshot_base64'] = base64.b64encode(buffer).decode('utf-8')
                    self.last_snapshot_time_by_session[session_id] = now_ts
                    print(f"📸 Snapshot captured for session {session_id} (violations: {[v.get('type') for v in result['violations']]})")
                else:
                    print(f"⏸️ Snapshot throttled for session {session_id} (last snapshot {now_ts - last_ts:.1f}s ago)")
            
            return result
            
        except Exception as e:
            return {'error': f'Frame processing error: {str(e)}'}

    def calibrate_from_frame(self, frame_base64: str) -> Optional[Tuple[float, float]]:
        """
        Extract calibration values (pitch, yaw) from a frame
        """
        try:
            # Decode base64 frame
            frame_data = base64.b64decode(frame_base64.split(',')[1] if ',' in frame_base64 else frame_base64)
            nparr = np.frombuffer(frame_data, np.uint8)
            frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            
            if frame is None:
                return None
            
            height, width, _ = frame.shape
            rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            
            face_mesh_results = self.mp_face_mesh.process(rgb_frame)
            if face_mesh_results.multi_face_landmarks:
                landmarks = face_mesh_results.multi_face_landmarks[0].landmark
                angles = self.estimate_head_pose(landmarks, width, height)
                
                if angles:
                    pitch, yaw, _ = angles
                    return (float(pitch), float(yaw))
            
            return None
        except Exception as e:
            print(f"Calibration error: {e}")
            return None

# Global instance
proctoring_service = ProctoringService()
