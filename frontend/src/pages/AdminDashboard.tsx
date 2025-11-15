import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Shield, Activity, Users, AlertTriangle, LogOut, Upload, RefreshCw, Download, FileText, Eye, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { pdfGenerator } from "@/utils/pdfGenerator";

const AdminDashboard = () => {
  const navigate = useNavigate();
  const [examSessions, setExamSessions] = useState<any[]>([]);
  const [violations, setViolations] = useState<any[]>([]);
  const [stats, setStats] = useState({
    totalSessions: 0,
    activeNow: 0,
    completed: 0,
    totalViolations: 0,
    avgViolationsPerStudent: 0,
    avgExamDuration: 0,
    totalStudents: 0,
  });
  const [chartData, setChartData] = useState<any[]>([]);
  const [studentsWithViolations, setStudentsWithViolations] = useState<any[]>([]);

  useEffect(() => {
    const isAuthenticated = sessionStorage.getItem('adminAuth');
    if (!isAuthenticated) {
      toast.error("Please login as admin");
      navigate('/admin/login');
      return;
    }

    loadDashboardData();

    // Real-time subscriptions with better error handling
    const violationSubscription = supabase
      .channel('violations-channel-dashboard')
      .on('postgres_changes', 
        { event: '*', schema: 'public', table: 'violations' },
        (payload) => {
          console.log('Violation update in dashboard:', payload);
          if (payload.eventType === 'INSERT') {
            toast.error('New violation detected!', {
              description: payload.new.violation_type?.replace(/_/g, ' ') || 'Unknown violation'
            });
          }
          loadDashboardData();
        }
      )
      .subscribe((status) => {
        console.log('Violation subscription status:', status);
        if (status === 'SUBSCRIBED') {
          console.log('✅ Violations channel subscribed');
        } else if (status === 'CHANNEL_ERROR') {
          console.error('❌ Violations channel error');
        }
      });

    const examsSubscription = supabase
      .channel('exams-channel-dashboard')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'exams' },
        (payload) => {
          console.log('Exam update in dashboard:', payload);
          loadDashboardData();
        }
      )
      .subscribe((status) => {
        console.log('Exam subscription status:', status);
        if (status === 'SUBSCRIBED') {
          console.log('✅ Exams channel subscribed');
        } else if (status === 'CHANNEL_ERROR') {
          console.error('❌ Exams channel error');
        }
      });

    // Auto-refresh every 8 seconds as backup (reduced from 10 for faster updates)
    const interval = setInterval(loadDashboardData, 8000);

    return () => {
      clearInterval(interval);
      supabase.removeChannel(violationSubscription);
      supabase.removeChannel(examsSubscription);
    };
  }, [navigate]);

  const loadDashboardData = async () => {
    try {
      const { data: examsData, error: examsError } = await supabase
        .from('exams')
        .select(`
          *,
          students (
            name,
            email,
            student_id
          ),
          exam_templates (
            subject_name,
            subject_code
          )
        `)
        .order('started_at', { ascending: false });
      
      // Ensure we have grade_letter and subject_name in exam data
      if (examsData) {
        examsData.forEach(exam => {
          if (!exam.grade_letter && exam.total_score !== undefined && exam.max_score !== undefined) {
            const percentage = exam.max_score > 0 ? Math.round((exam.total_score / exam.max_score) * 100) : 0;
            exam.grade_letter = percentage >= 90 ? 'A+' : percentage >= 85 ? 'A' : percentage >= 80 ? 'B+' : percentage >= 75 ? 'B' : percentage >= 70 ? 'C+' : percentage >= 65 ? 'C' : percentage >= 60 ? 'D' : 'F';
          }
          if (!exam.subject_name && exam.exam_templates) {
            exam.subject_name = exam.exam_templates.subject_name;
          }
        });
      }

      if (examsError) throw examsError;

      // Fetch all violations - don't require foreign key joins (allow NULLs)
      const { data: violationsData } = await supabase
        .from('violations')
        .select('*')
        .order('timestamp', { ascending: false });

      setViolations(violationsData || []);

      // Calculate stats
      const activeCount = (examsData || []).filter(e => e.status === 'in_progress').length;
      const completedCount = (examsData || []).filter(e => e.status === 'completed').length;
      const totalViolations = violationsData?.length || 0;
      const totalStudents = new Set((examsData || []).map(e => e.student_id)).size;
      
      const avgViolations = totalStudents > 0 ? (totalViolations / totalStudents).toFixed(1) : 0;
      
      const completedExams = (examsData || []).filter(e => e.status === 'completed' && e.started_at && e.completed_at);
      const avgDuration = completedExams.length > 0
        ? Math.round(completedExams.reduce((sum, e) => {
            const start = new Date(e.started_at).getTime();
            const end = new Date(e.completed_at).getTime();
            return sum + (end - start) / 1000 / 60;
          }, 0) / completedExams.length)
        : 0;

      setStats({
        totalSessions: examsData?.length || 0,
        activeNow: activeCount,
        completed: completedCount,
        totalViolations,
        avgViolationsPerStudent: Number(avgViolations),
        avgExamDuration: avgDuration,
        totalStudents,
      });

      setExamSessions(examsData || []);
      prepareChartData(violationsData || []);
      groupViolationsByStudent(examsData || [], violationsData || []);

    } catch (error) {
      console.error('Error loading dashboard data:', error);
    }
  };

  const prepareChartData = (violations: any[]) => {
    const hourlyData: { [key: string]: number } = {};
    
    violations.forEach(v => {
      const time = new Date(v.timestamp);
      const hourKey = time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
      hourlyData[hourKey] = (hourlyData[hourKey] || 0) + 1;
    });

    const data = Object.entries(hourlyData)
      .map(([time, violations]) => ({ time, violations }))
      .slice(-10);

    setChartData(data);
  };

  const groupViolationsByStudent = (exams: any[], violations: any[]) => {
    const studentMap: { [key: string]: any } = {};

    // First, create a map of exam_id to exam for quick lookup
    const examMap = new Map();
    exams.forEach(exam => {
      examMap.set(exam.id, exam);
    });

    // Group violations by matching them to exams first, then by student
    violations.forEach(violation => {
      const examId = violation.exam_id;
      let exam = null;
      let studentKey = null;
      let studentName = null;
      let studentId = null;
      let subjectName = null;
      let subjectCode = null;
      
      // Try to find the exam for this violation
      if (examId) {
        exam = examMap.get(examId);
      }
      
      // If exam found, use exam's student info
      if (exam && exam.students) {
        studentName = exam.students.name;
        studentId = exam.students.student_id || exam.students.id;
        subjectName = exam.subject_name || exam.exam_templates?.subject_name || 'N/A';
        subjectCode = exam.subject_code || exam.exam_templates?.subject_code || 'N/A';
        // Use student name as key to consolidate all exams for same student
        studentKey = studentName?.toLowerCase() || `student_${exam.students.id}`;
      } else {
        // Fallback to violation details
        studentName = violation.details?.student_name || 'Unknown Student';
        studentId = violation.details?.student_id || violation.student_id || 'unknown';
        subjectName = violation.details?.subject_name || 'N/A';
        subjectCode = violation.details?.subject_code || 'N/A';
        // Use student name as key
        studentKey = studentName?.toLowerCase() || `unknown_${studentId}`;
      }
      
      // Initialize student entry if not exists
      if (!studentMap[studentKey]) {
        // Find all exams for this student to get the most complete info
        const studentExams = exams.filter(e => 
          (e.students?.name && studentName && e.students.name.toLowerCase() === studentName.toLowerCase()) ||
          (e.students?.student_id && studentId && e.students.student_id === studentId) ||
          (e.students?.id && violation.student_id && e.students.id === violation.student_id) ||
          (e.id === examId && exam)
        );
        
        // Sort exams: prefer ones with complete info (student_id and subject_name), then by most recent
        const sortedExams = studentExams.sort((a, b) => {
          const aComplete = (a.students?.student_id && a.exam_templates?.subject_name) ? 1 : 0;
          const bComplete = (b.students?.student_id && b.exam_templates?.subject_name) ? 1 : 0;
          if (aComplete !== bComplete) return bComplete - aComplete;
          // If both complete or both incomplete, use most recent
          const aTime = new Date(a.started_at || a.created_at || 0).getTime();
          const bTime = new Date(b.started_at || b.created_at || 0).getTime();
          return bTime - aTime;
        });
        
        // Use the best exam (most complete info, most recent)
        const bestExam = sortedExams[0] || exam;
        
        studentMap[studentKey] = {
          name: bestExam?.students?.name || studentName,
          studentId: bestExam?.students?.student_id || studentId || 'unknown',
          id: bestExam?.students?.id || violation.student_id || 'unknown',
          examId: bestExam?.id || examId || 'unknown',
          violationCount: 0,
          violationTypes: [],
          violations: [],
          subjectName: bestExam?.subject_name || bestExam?.exam_templates?.subject_name || subjectName || 'N/A',
          subjectCode: bestExam?.subject_code || bestExam?.exam_templates?.subject_code || subjectCode || 'N/A',
        };
      }
      
      // Add violation to this student's collection
      studentMap[studentKey].violationCount++;
      if (!studentMap[studentKey].violationTypes.includes(violation.violation_type)) {
        studentMap[studentKey].violationTypes.push(violation.violation_type);
      }
      studentMap[studentKey].violations.push(violation);
    });

    setStudentsWithViolations(Object.values(studentMap));
  };

  const handleLogout = () => {
    sessionStorage.removeItem('adminAuth');
    toast.success("Logged out");
    navigate('/');
  };

  const handleExportCSV = async (student: any) => {
    try {
      const csvContent = await pdfGenerator.exportToCSV(student.violations);
      const blob = new Blob([csvContent], { type: 'text/csv' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${student.name}_violations.csv`;
      a.click();
      toast.success("CSV exported");
    } catch (error) {
      console.error('Error exporting CSV:', error);
      toast.error("Failed to export CSV");
    }
  };

  const handleGenerateReport = async (student: any) => {
    try {
      toast.info("Generating PDF report...");
      
      // Find the exam for this student to get grade information
      const examId = student.examId || examSessions.find(e => e.student_id === student.id)?.id;
      const exam = examSessions.find(e => e.id === examId || e.student_id === student.id);
      let examScore = undefined;
      
      if (exam && exam.total_score !== undefined && exam.max_score !== undefined) {
        const percentage = exam.max_score > 0 ? Math.round((exam.total_score / exam.max_score) * 100) : 0;
        examScore = {
          total_score: exam.total_score,
          max_score: exam.max_score,
          percentage: percentage,
          grade_letter: exam.grade_letter || (percentage >= 90 ? 'A+' : percentage >= 85 ? 'A' : percentage >= 80 ? 'B+' : percentage >= 75 ? 'B' : percentage >= 70 ? 'C+' : percentage >= 65 ? 'C' : percentage >= 60 ? 'D' : 'F')
        };
      }
      
      const pdfUrl = await pdfGenerator.generateStudentReport(
        student.name,
        student.studentId,
        student.violations,
        student.subjectName,
        student.subjectCode,
        examScore
      );
      
      // Only open in new window if it's a valid URL (not a blob URL that was already downloaded)
      if (pdfUrl && pdfUrl !== 'local-download' && pdfUrl.startsWith('http')) {
        window.open(pdfUrl, '_blank');
        toast.success("Report generated and saved to Supabase");
      } else if (pdfUrl && pdfUrl.startsWith('blob:')) {
        // Blob URL means download was triggered, just show success
        toast.success("Report downloaded successfully");
      } else {
        toast.success("Report generated successfully");
      }
    } catch (error) {
      console.error('Error generating report:', error);
      const errorMessage = error instanceof Error ? error.message : String(error) || 'Unknown error';
      toast.error(`Failed to generate report: ${errorMessage}`);
    }
  };

  const handleExportAllCSV = async () => {
    try {
      const csvContent = await pdfGenerator.exportToCSV(violations);
      const blob = new Blob([csvContent], { type: 'text/csv' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `all_violations_${Date.now()}.csv`;
      a.click();
      toast.success("CSV exported");
    } catch (error) {
      toast.error("Failed to export");
    }
  };

  const formatDate = (dateString: string) => {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
  };

  const getViolationTypeIcon = (type: string) => {
    const icons: Record<string, string> = {
      'phone_detected': '📱',
      'book_detected': '📚',
      'multiple_faces': '👥',
      'no_person': '❌',
      'object_detected': '📦',
      'looking_away': '👀',
      'excessive_noise': '🔊',
      'tab_switch': '🗂️',
      'copy_paste': '📋',
      'window_blur': '💤',
      'eye_movement': '👁️',
      'shoulder_movement': '🤸'
    };
    return icons[type] || '⚠️';
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-primary flex items-center justify-center">
              <Shield className="w-7 h-7 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-xl font-bold">Admin Dashboard</h1>
              <p className="text-sm text-muted-foreground">Real-time Exam Monitoring</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="default" size="sm" onClick={() => navigate('/admin/analytics')}>
              <Activity className="w-4 h-4 mr-2" />
              Analytics
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate('/admin/monitor')}>
              <Monitor className="w-4 h-4 mr-2" />
              Live Monitor
            </Button>
            <Button variant="outline" size="sm" onClick={loadDashboardData}>
              <RefreshCw className="w-4 h-4 mr-2" />
              Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={handleExportAllCSV}>
              <Download className="w-4 h-4 mr-2" />
              Export CSV
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate('/admin/upload-template')}>
              <Upload className="w-4 h-4 mr-2" />
              Upload Template
            </Button>
            <Button variant="outline" size="sm" onClick={handleLogout}>
              <LogOut className="w-4 h-4 mr-2" />
              Logout
            </Button>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8">
        {/* Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Total Sessions</p>
                  <p className="text-3xl font-bold">{stats.totalSessions}</p>
                </div>
                <Activity className="w-8 h-8 text-primary" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Active Now</p>
                  <p className="text-3xl font-bold text-green-600">{stats.activeNow}</p>
                </div>
                <Users className="w-8 h-8 text-green-600" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Completed</p>
                  <p className="text-3xl font-bold">{stats.completed}</p>
                </div>
                <Shield className="w-8 h-8 text-primary" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Total Violations</p>
                  <p className="text-3xl font-bold text-red-600">{stats.totalViolations}</p>
                </div>
                <AlertTriangle className="w-8 h-8 text-red-600" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div>
                <p className="text-sm text-muted-foreground">Avg Violations/Student</p>
                <p className="text-3xl font-bold text-orange-600">{stats.avgViolationsPerStudent}</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div>
                <p className="text-sm text-muted-foreground">Avg Exam Duration</p>
                <p className="text-3xl font-bold">{stats.avgExamDuration} min</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div>
                <p className="text-sm text-muted-foreground">Total Students</p>
                <p className="text-3xl font-bold text-primary">{stats.totalStudents}</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Violations Over Time Chart */}
        <Card className="mb-8">
          <CardContent className="p-6">
            <h2 className="text-xl font-bold mb-6">Violations Over Time</h2>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="time" />
                <YAxis />
                <Tooltip />
                <Line 
                  type="monotone" 
                  dataKey="violations" 
                  stroke="#ef4444" 
                  strokeWidth={2} 
                  dot={{ r: 4 }} 
                />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Recent Violation Evidence Gallery */}
        <Card className="mb-8">
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2">
                <Eye className="w-5 h-5" />
                <h2 className="text-xl font-bold">Recent Violation Evidence Gallery</h2>
                <Badge variant="secondary">{violations.filter(v => v.image_url).length} Images</Badge>
              </div>
            </div>
            
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {violations
                .filter(v => v.image_url)
                .slice(0, 8)
                .map((violation) => (
                  <div key={violation.id} className="relative group">
                    <div className="aspect-video rounded-lg overflow-hidden border-2 border-border hover:border-red-500 transition-colors">
                      <img 
                        src={violation.image_url} 
                        alt={violation.violation_type}
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          e.currentTarget.src = '/placeholder.svg';
                        }}
                      />
                    </div>
                    <div className="absolute top-2 left-2">
                      <Badge variant="destructive" className="text-xs">
                        {getViolationTypeIcon(violation.violation_type)} {violation.violation_type.replace(/_/g, ' ')}
                      </Badge>
                    </div>
                    <div className="mt-2">
                      <p className="text-xs font-medium">{violation.details?.student_name || 'Unknown Student'}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatDate(violation.timestamp)}
                      </p>
                    </div>
                  </div>
                ))}
            </div>

            {violations.filter(v => v.image_url).length === 0 && (
              <div className="text-center py-12 text-muted-foreground">
                No violation evidence images found
              </div>
            )}
          </CardContent>
        </Card>

        <div className="grid lg:grid-cols-3 gap-6">
          {/* Students with Violations */}
          <div className="lg:col-span-2">
            <Card>
              <CardContent className="p-6">
                <div className="flex items-center gap-2 mb-6">
                  <Users className="w-5 h-5" />
                  <h2 className="text-xl font-bold">Students with Violations</h2>
                  <Badge variant="destructive">{studentsWithViolations.length} Students</Badge>
                </div>

                <div className="space-y-4">
                  {studentsWithViolations.map((student) => (
                    <div key={student.id} className="border rounded-lg p-4">
                      <div className="flex items-start justify-between mb-3">
                        <div>
                          <h3 className="font-bold">{student.name}</h3>
                          <p className="text-sm text-muted-foreground">{student.studentId}</p>
                          <p className="text-xs text-muted-foreground mt-1">
                            <span className="font-medium">Subject:</span> {student.subjectName} ({student.subjectCode})
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <AlertTriangle className="w-5 h-5 text-red-600" />
                          <span className="font-bold text-red-600">{student.violationCount} Violations</span>
                        </div>
                      </div>
                      
                      <div className="flex flex-wrap gap-2 mb-3">
                        {student.violationTypes.map((type: string) => (
                          <Badge key={type} variant="secondary" className="text-xs">
                            {getViolationTypeIcon(type)} {type.replace(/_/g, ' ')}
                          </Badge>
                        ))}
                      </div>

                      <div className="flex gap-2">
                        <Button 
                          size="sm" 
                          variant="default" 
                          onClick={async () => {
                            // Use examId from student object if available, otherwise find it
                            const examId = student.examId || examSessions.find(e => 
                              e.student_id === student.id || 
                              e.students?.student_id === student.studentId ||
                              e.student_id === student.studentId
                            )?.id;
                            
                            if (examId && student.id) {
                              navigate(`/admin/student-report?studentId=${student.id}&examId=${examId}`);
                            } else {
                              toast.error("No exam found for this student. Please check the exam data.");
                            }
                          }}
                        >
                          <Eye className="w-4 h-4 mr-1" />
                          View Report
                        </Button>
                        <Button 
                          size="sm" 
                          variant="outline" 
                          onClick={() => handleGenerateReport(student)}
                        >
                          <FileText className="w-4 h-4 mr-1" />
                          Generate PDF
                        </Button>
                        <Button 
                          size="sm" 
                          variant="outline" 
                          onClick={() => handleExportCSV(student)}
                        >
                          <Download className="w-4 h-4 mr-1" />
                          Export CSV
                        </Button>
                      </div>
                    </div>
                  ))}
                  {studentsWithViolations.length === 0 && (
                    <div className="text-center py-12 text-muted-foreground">
                      No violations detected yet
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Recent Activity */}
          <div>
            <Card>
              <CardContent className="p-6">
                <h2 className="text-xl font-bold mb-6">Recent Activity</h2>
                <div className="space-y-3">
                  {violations.slice(0, 10).map((violation) => (
                    <div key={violation.id} className="text-sm border-l-2 border-red-500 pl-3 py-1">
                      <p className="font-medium">{violation.details?.student_name || 'Unknown Student'}</p>
                      <p className="text-muted-foreground">
                        {getViolationTypeIcon(violation.violation_type)} {violation.violation_type.replace(/_/g, ' ')}
                      </p>
                      <p className="text-xs text-muted-foreground">{formatDate(violation.timestamp)}</p>
                    </div>
                  ))}
                  {violations.length === 0 && (
                    <p className="text-center text-muted-foreground py-8">No recent activity</p>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AdminDashboard;
