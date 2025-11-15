import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Download, FileText, Calendar, Clock, AlertTriangle, CheckCircle, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { pdfGenerator } from "@/utils/pdfGenerator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface StudentReportData {
  student: {
    id: string;
    name: string;
    email: string;
    student_id: string;
  };
  exam: {
    id: string;
    subject_code: string;
    started_at: string;
    completed_at: string;
    status: string;
    subject_name: string;
    duration_minutes: number;
    total_score?: number;
    max_score?: number;
    graded?: boolean;
    percentage?: number;
    grade_letter?: string | null;
  };
  answers: Array<{
    question_number: number;
    question_text: string;
    question_type: string;
    answer: string;
    correct_answer?: string;
    points: number;
    options?: any;
  }>;
  violations: Array<{
    id: string;
    violation_type: string;
    severity: string;
    timestamp: string;
    image_url?: string;
    details?: any;
  }>;
}

const StudentReport = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const studentId = searchParams.get("studentId");
  const examId = searchParams.get("examId");
  
  const [reportData, setReportData] = useState<StudentReportData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const isAuthenticated = sessionStorage.getItem('adminAuth');
    if (!isAuthenticated) {
      toast.error("Please login as admin");
      navigate('/admin/login');
      return;
    }

    if (!studentId || !examId) {
      toast.error("Missing student or exam information");
      navigate('/admin/dashboard');
      return;
    }

    loadReportData();
  }, [studentId, examId, navigate]);

  const loadReportData = async () => {
    try {
      setLoading(true);

      const { data: studentData, error: studentError } = await supabase
        .from('students')
        .select('id, name, email, student_id, subject_code, face_image_url, created_at')
        .eq('id', studentId)
        .single();

      if (studentError) throw studentError;

      const { data: examData, error: examError } = await supabase
        .from('exams')
        .select(`
          *,
          exam_templates (
            subject_name,
            subject_code,
            duration_minutes
          )
        `)
        .eq('id', examId)
        .single();

      if (examError) throw examError;

      const { data: answersData, error: answersError } = await supabase
        .from('exam_answers')
        .select('*')
        .eq('exam_id', examId)
        .order('question_number');

      if (answersError) throw answersError;

      let questionsData = null;
      if (examData.exam_template_id) {
        const { data, error: questionsError } = await supabase
          .from('exam_questions')
          .select('*')
          .eq('exam_template_id', examData.exam_template_id)
          .order('question_number');

        if (questionsError) throw questionsError;
        questionsData = data;
      }

      const answersWithQuestions = (answersData || []).map(answer => {
        const question = questionsData?.find(q => q.question_number === answer.question_number);
        return {
          question_number: answer.question_number,
          question_text: question?.question_text || 'Question not found',
          question_type: question?.question_type || 'short_answer',
          answer: answer.answer || 'Not answered',
          correct_answer: question?.correct_answer,
          points: question?.points || 0,
          options: question?.options,
        };
      });

      let violationsData = [];

      try {
        const { data: violationsByExam } = await supabase
          .from('violations')
          .select('*')
          .eq('exam_id', examId)
          .order('timestamp');

        const { data: violationsByStudent } = await supabase
          .from('violations')
          .select('*')
          .eq('student_id', studentId)
          .order('timestamp');

        const { data: violationsByName } = await supabase
          .from('violations')
          .select('*')
          .ilike('details->>student_name', `%${studentData.name}%`)
          .order('timestamp');

        const allViolationsMap = new Map();
        
        [...(violationsByExam || []), ...(violationsByStudent || []), ...(violationsByName || [])]
          .forEach(v => {
            if (v && v.id) {
              allViolationsMap.set(v.id, v);
            }
          });
        
        violationsData = Array.from(allViolationsMap.values());
        
      } catch (error) {
        console.error('Error fetching violations:', error);
        violationsData = [];
      }

      const finalStudentData = {
        id: studentData.id,
        name: studentData.name || 'Unknown',
        email: studentData.email || 'N/A',
        student_id: studentData.student_id || studentData.subject_code || studentData.email || 'Unknown',
      };

      setReportData({
        student: finalStudentData,
        exam: {
          id: examData.id,
          subject_code: examData.subject_code || examData.exam_templates?.subject_code || 'N/A',
          started_at: examData.started_at,
          completed_at: examData.completed_at,
          status: examData.status,
          subject_name: (examData as any).subject_name || examData.exam_templates?.subject_name || 'N/A',
          duration_minutes: examData.exam_templates?.duration_minutes || examData.duration_minutes || 0,
          total_score: (examData as any).total_score || 0,
          max_score: (examData as any).max_score || 0,
          graded: (examData as any).graded || false,
          percentage: (examData as any).max_score > 0 ? Math.round(((examData as any).total_score / (examData as any).max_score) * 100) : 0,
          grade_letter: (examData as any).grade_letter || null
        },
        answers: answersWithQuestions,
        violations: violationsData || [],
      });

      setLoading(false);
    } catch (error) {
      console.error('Error loading report data:', error);
      toast.error("Failed to load report data");
      setLoading(false);
    }
  };

  const calculateScore = () => {
    if (!reportData) return { correct: 0, total: 0, percentage: 0, totalPoints: 0, earnedPoints: 0 };
    
    let correct = 0;
    let earnedPoints = 0;
    let totalPoints = 0;
    const total = reportData.answers.length;
    
    reportData.answers.forEach(answer => {
      const points = answer.points || 1;
      totalPoints += points;
      
      if (answer.question_type === 'mcq' && answer.correct_answer) {
        if (answer.answer?.trim().toLowerCase() === answer.correct_answer?.trim().toLowerCase()) {
          correct++;
          earnedPoints += points;
        }
      } else if (answer.question_type === 'short_answer' && answer.answer && answer.answer.trim() !== '') {
        earnedPoints += points * 0.8;
      }
    });
    
    const percentage = totalPoints > 0 ? Math.round((earnedPoints / totalPoints) * 100) : 0;
    return { correct, total, percentage, totalPoints, earnedPoints };
  };

  const handleDownloadPDF = async () => {
    if (!reportData) return;
    
    try {
      toast.info("Generating PDF report...");
      
      const score = calculateScore();
      const actualScore = reportData.exam.graded && reportData.exam.total_score !== undefined;
      
      const examScore = {
        total_score: actualScore ? reportData.exam.total_score : Math.round(score.earnedPoints),
        max_score: actualScore ? reportData.exam.max_score : score.totalPoints,
        percentage: actualScore ? reportData.exam.percentage : score.percentage,
        grade_letter: reportData.exam.grade_letter || (() => {
          const pct = actualScore ? reportData.exam.percentage : score.percentage;
          if (pct >= 90) return 'A+';
          if (pct >= 85) return 'A';
          if (pct >= 80) return 'A-';
          if (pct >= 75) return 'B+';
          if (pct >= 70) return 'B';
          if (pct >= 65) return 'B-';
          if (pct >= 60) return 'C+';
          if (pct >= 55) return 'C';
          if (pct >= 50) return 'C-';
          if (pct >= 40) return 'D';
          return 'F';
        })()
      };
      
      const pdfUrl = await pdfGenerator.generateStudentReport(
        reportData.student.name,
        reportData.student.student_id,
        reportData.violations,
        reportData.exam.subject_name,
        reportData.exam.subject_code,
        examScore
      );
      
      if (pdfUrl && pdfUrl.startsWith('http')) {
        window.open(pdfUrl, '_blank');
        toast.success("Report generated successfully");
      } else if (pdfUrl && pdfUrl.startsWith('blob:')) {
        toast.success("Report downloaded successfully");
      } else {
        toast.success("Report generated successfully");
      }
    } catch (error) {
      console.error('Error generating PDF:', error);
      toast.error(`Failed to generate PDF: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handleDownloadCSV = async () => {
    if (!reportData) return;
    
    try {
      const csvContent = await pdfGenerator.exportToCSV(reportData.violations);
      const blob = new Blob([csvContent], { type: 'text/csv' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${reportData.student.name}_violations_${Date.now()}.csv`;
      a.click();
      toast.success("CSV exported successfully");
    } catch (error) {
      console.error('Error exporting CSV:', error);
      toast.error("Failed to export CSV");
    }
  };

  const formatDate = (dateString: string) => {
    if (!dateString) return 'N/A';
    return new Date(dateString).toLocaleString();
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading report...</p>
        </div>
      </div>
    );
  }

  if (!reportData) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <p className="text-muted-foreground">No report data found</p>
          <Button onClick={() => navigate('/admin/dashboard')} className="mt-4">
            Back to Dashboard
          </Button>
        </div>
      </div>
    );
  }

  const score = calculateScore();

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="icon" onClick={() => navigate('/admin/dashboard')}>
                <ArrowLeft className="w-5 h-5" />
              </Button>
              <div>
                <h1 className="text-xl font-bold">Student Report</h1>
                <p className="text-sm text-muted-foreground">{reportData.student.name}</p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleDownloadCSV}>
                <Download className="w-4 h-4 mr-2" />
                CSV
              </Button>
              <Button variant="default" size="sm" onClick={handleDownloadPDF}>
                <FileText className="w-4 h-4 mr-2" />
                PDF Report
              </Button>
            </div>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8 max-w-7xl">
        <div className="grid md:grid-cols-2 gap-6 mb-8">
          <Card>
            <CardHeader>
              <CardTitle>Student Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <p className="text-sm text-muted-foreground">Name</p>
                <p className="font-medium">{reportData.student.name}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Student ID</p>
                <p className="font-medium">{reportData.student.student_id}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Email</p>
                <p className="font-medium">{reportData.student.email}</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Exam Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <p className="text-sm text-muted-foreground">Subject</p>
                <p className="font-medium">{reportData.exam.subject_name}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Subject Code</p>
                <p className="font-medium">{reportData.exam.subject_code}</p>
              </div>
              <div className="flex items-center gap-4">
                <div>
                  <p className="text-sm text-muted-foreground flex items-center gap-1">
                    <Calendar className="w-3 h-3" /> Started
                  </p>
                  <p className="text-sm font-medium">{formatDate(reportData.exam.started_at)}</p>
                </div>
                {reportData.exam.completed_at && (
                  <div>
                    <p className="text-sm text-muted-foreground flex items-center gap-1">
                      <Clock className="w-3 h-3" /> Completed
                    </p>
                    <p className="text-sm font-medium">{formatDate(reportData.exam.completed_at)}</p>
                  </div>
                )}
              </div>
              <div>
                <Badge variant={reportData.exam.status === 'completed' ? 'default' : 'secondary'}>
                  {reportData.exam.status}
                </Badge>
              </div>
            </CardContent>
          </Card>
        </div>

        {(reportData.answers.some(a => a.question_type === 'mcq') || reportData.exam.graded) && (
          <Card className="mb-8">
            <CardHeader>
              <CardTitle>Score Summary</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-8">
                <div className="text-center">
                  <div className="text-4xl font-bold text-primary">
                    {reportData.exam.graded ? reportData.exam.percentage : score.percentage}%
                  </div>
                  <p className="text-sm text-muted-foreground">Overall Score</p>
                  {reportData.exam.grade_letter && (
                    <Badge variant="default" className="mt-2">
                      Grade: {reportData.exam.grade_letter}
                    </Badge>
                  )}
                </div>
                <Separator orientation="vertical" className="h-16" />
                <div className="flex-1">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm">Points Earned</span>
                    <span className="font-bold text-success">
                      {reportData.exam.graded ? reportData.exam.total_score : Math.round(score.earnedPoints)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm">Total Points</span>
                    <span className="font-bold">
                      {reportData.exam.graded ? reportData.exam.max_score : score.totalPoints}
                    </span>
                  </div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm">Questions Answered</span>
                    <span className="font-bold">{score.total}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm">Violations</span>
                    <span className="font-bold text-destructive">{reportData.violations.length}</span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        <Card className="mb-8">
          <CardHeader>
            <CardTitle>Exam Answers</CardTitle>
          </CardHeader>
          <CardContent>
            {reportData.answers.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">No answers submitted</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16">Q#</TableHead>
                    <TableHead>Question</TableHead>
                    <TableHead>Student Answer</TableHead>
                    <TableHead>Correct Answer</TableHead>
                    <TableHead className="w-20">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reportData.answers.map((answer) => {
                    const isCorrect = answer.question_type === 'mcq' && answer.correct_answer 
                      ? answer.answer?.trim().toUpperCase() === answer.correct_answer?.trim().toUpperCase()
                      : null;
                    
                    return (
                      <TableRow key={answer.question_number}>
                        <TableCell className="font-medium">{answer.question_number}</TableCell>
                        <TableCell>
                          <div className="max-w-md">
                            <p className="mb-2">{answer.question_text}</p>
                            {answer.question_type === 'mcq' && answer.options && (
                              <div className="text-xs text-muted-foreground space-y-1">
                                {Object.entries(answer.options).map(([key, value]) => (
                                  <div key={key} className="flex gap-2">
                                    <span className="font-medium">{key}:</span>
                                    <span>{value as string}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className={isCorrect === false ? 'text-destructive font-medium' : ''}>
                            {answer.answer || <span className="text-muted-foreground italic">Not answered</span>}
                          </span>
                        </TableCell>
                        <TableCell>
                          {answer.correct_answer || <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell>
                          {isCorrect === true && <CheckCircle className="w-5 h-5 text-success" />}
                          {isCorrect === false && <XCircle className="w-5 h-5 text-destructive" />}
                          {isCorrect === null && <span className="text-muted-foreground text-xs">Manual</span>}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5" />
              Violations ({reportData.violations.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {reportData.violations.length === 0 ? (
              <div className="text-center py-8">
                <CheckCircle className="w-16 h-16 text-success mx-auto mb-4" />
                <p className="text-lg font-medium text-success">No violations detected</p>
                <p className="text-sm text-muted-foreground">This student had a clean exam session</p>
              </div>
            ) : (
              <div className="space-y-4">
                {reportData.violations.map((violation) => (
                  <div key={violation.id} className="border rounded-lg p-4">
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-2">
                          <Badge variant="destructive">{violation.violation_type.replace(/_/g, ' ')}</Badge>
                          <Badge variant="outline">{violation.severity}</Badge>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          <Clock className="w-3 h-3 inline mr-1" />
                          {formatDate(violation.timestamp)}
                        </p>
                        {violation.details?.message && (
                          <p className="text-sm mt-2">{violation.details.message}</p>
                        )}
                        {violation.details?.confidence && (
                          <p className="text-xs text-muted-foreground mt-1">
                            Confidence: {(violation.details.confidence * 100).toFixed(1)}%
                          </p>
                        )}
                      </div>
                      {violation.image_url ? (
                        <div className="ml-4 text-center">
                          <div className="text-xs text-muted-foreground mb-1 font-semibold">📷 Evidence Captured</div>
                          <img 
                            src={violation.image_url}
                            alt="Violation evidence"
                            className="w-32 h-24 object-cover rounded border-2 border-red-500 cursor-pointer hover:scale-105 transition-transform"
                            onClick={() => window.open(violation.image_url, '_blank')}
                            title="Click to view full image"
                            onError={(e) => {
                              console.error('Failed to load evidence image:', violation.image_url);
                              e.currentTarget.src = '/placeholder.svg';
                            }}
                          />
                          <div className="text-xs text-red-600 mt-1">Click to enlarge</div>
                        </div>
                      ) : (
                        <div className="ml-4 text-center">
                          <div className="text-xs text-muted-foreground mb-1">📷 No Evidence</div>
                          <div className="w-32 h-24 bg-gray-100 rounded border-2 border-gray-300 flex items-center justify-center">
                            <span className="text-xs text-gray-500">No Image</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default StudentReport;