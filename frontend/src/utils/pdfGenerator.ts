import jsPDF from 'jspdf';
import { supabase } from '@/integrations/supabase/client';

interface ViolationData {
  id: string;
  violation_type: string;
  severity: string;
  timestamp: string;
  image_url?: string;
  details?: any;
}

export class PDFGenerator {
  async generateStudentReport(
    studentName: string,
    studentId: string,
    violations: ViolationData[],
    subjectName?: string,
    subjectCode?: string,
    examScore?: { total_score: number; max_score: number; percentage: number; grade_letter: string }
  ): Promise<string> {
    try {
      // Validate inputs - allow empty but provide defaults
      const safeStudentName = studentName || 'Unknown Student';
      const safeStudentId = studentId || 'Unknown';
      
      // Ensure violations is an array
      const violationsArray = Array.isArray(violations) ? violations : [];
      
      console.log('Generating PDF for:', { 
        studentName: safeStudentName, 
        studentId: safeStudentId, 
        subjectName: subjectName || 'N/A', 
        subjectCode: subjectCode || 'N/A', 
        violationCount: violationsArray.length,
        violationTypes: [...new Set(violationsArray.map(v => v.violation_type))]
      });
      
      const pdf = new jsPDF();
      const pageWidth = pdf.internal.pageSize.getWidth();
    
    // Header
    pdf.setFontSize(20);
    pdf.setTextColor(220, 38, 38);
    pdf.text('Student Exam Report', pageWidth / 2, 20, { align: 'center' });
    
    // Student Info Section
    pdf.setFontSize(12);
    pdf.setTextColor(0, 0, 0);
    let yPos = 40;
    
    // Always show student ID, even if it's unknown
    const displayStudentId = safeStudentId && safeStudentId !== 'N/A' && safeStudentId !== 'Unknown' ? safeStudentId : 'ID Not Available';
    pdf.text(`Student ID: ${displayStudentId}`, 20, yPos);
    yPos += 8;
    pdf.text(`Student Name: ${safeStudentName}`, 20, yPos);
    yPos += 8;
    
    // Always show subject information if available
    const displaySubjectName = subjectName && subjectName !== 'N/A' ? subjectName : 'Subject Not Available';
    const displaySubjectCode = subjectCode && subjectCode !== 'N/A' ? subjectCode : 'Code Not Available';
    
    pdf.text(`Subject: ${displaySubjectName}`, 20, yPos);
    yPos += 8;
    pdf.text(`Subject Code: ${displaySubjectCode}`, 20, yPos);
    yPos += 8;
    
    // Exam Score Section (if available)
    if (examScore) {
      pdf.setFontSize(14);
      pdf.setTextColor(34, 139, 34); // Green color for score
      pdf.text('Exam Results:', 20, yPos);
      yPos += 8;
      
      pdf.setFontSize(12);
      pdf.setTextColor(0, 0, 0);
      pdf.text(`Score: ${examScore.total_score}/${examScore.max_score} (${examScore.percentage}%)`, 20, yPos);
      yPos += 8;
      pdf.text(`Grade: ${examScore.grade_letter}`, 20, yPos);
      yPos += 10;
    }
    
    pdf.text(`Generated: ${new Date().toLocaleString()}`, 20, yPos);
    yPos += 5;
    
    // Separator
    const separatorY = yPos;
    pdf.setLineWidth(0.5);
    pdf.setDrawColor(220, 38, 38);
    pdf.line(20, separatorY, pageWidth - 20, separatorY);
    
    // Summary Section
    pdf.setFontSize(16);
    pdf.text('Summary', 20, separatorY + 13);
    
    pdf.setFontSize(12);
    pdf.text(`Total Violations: ${violationsArray.length}`, 20, separatorY + 23);
    pdf.text(`Report Generated: ${new Date().toLocaleString()}`, 20, separatorY + 31);
    
    // Violation Breakdown
    pdf.setFontSize(14);
    pdf.text('Violation Breakdown', 20, separatorY + 48);
    
    // Count violations by type - ensure all violation types are included
    const violationCounts: { [key: string]: number } = {};
    violationsArray.forEach(v => {
      const type = v.violation_type || 'unknown';
      violationCounts[type] = (violationCounts[type] || 0) + 1;
    });
    
    console.log('PDF Generation - Violation counts:', violationCounts);
    console.log('PDF Generation - Total violations:', violationsArray.length);
    console.log('PDF Generation - Violation types found:', Object.keys(violationCounts));
    
    // Table Header
    const tableHeaderY = separatorY + 56;
    pdf.setFontSize(11);
    pdf.setFillColor(220, 38, 38);
    pdf.rect(20, tableHeaderY, pageWidth - 40, 8, 'F');
    pdf.setTextColor(255, 255, 255);
    pdf.text('Violation Type', 25, tableHeaderY + 5);
    pdf.text('Count', pageWidth / 2, tableHeaderY + 5);
    pdf.text('Percentage', pageWidth - 60, tableHeaderY + 5);
    
    // Table Rows
    pdf.setTextColor(0, 0, 0);
    let tableYPos = tableHeaderY + 15;
    Object.entries(violationCounts).forEach(([type, count], index) => {
      const percentage = violationsArray.length > 0 ? ((count / violationsArray.length) * 100).toFixed(1) : '0.0';
      
      if (index % 2 === 0) {
        pdf.setFillColor(245, 245, 245);
        pdf.rect(20, tableYPos - 5, pageWidth - 40, 8, 'F');
      }
      
      pdf.text(type.replace(/_/g, ' '), 25, tableYPos);
      pdf.text(count.toString(), pageWidth / 2, tableYPos);
      pdf.text(`${percentage}%`, pageWidth - 60, tableYPos);
      
      tableYPos += 10;
    });
    
    // Detailed Violations with Evidence Images
    if (tableYPos > 200) {
      pdf.addPage();
      yPos = 20;
    } else {
      yPos = tableYPos + 10;
    }
    
    pdf.setFontSize(14);
    pdf.text('Detailed Violations with Evidence', 20, yPos);
    yPos += 10;
    
    // Include up to 10 violations with images
    const violationsToShow = violationsArray.slice(0, 10);
    
    for (let index = 0; index < violationsToShow.length; index++) {
      const violation = violationsToShow[index];
      
      // Check if we need a new page (accounting for image space)
      if (yPos > 220) {
        pdf.addPage();
        yPos = 20;
      }
      
      // Violation details
      pdf.setFontSize(11);
      pdf.setTextColor(0, 0, 0);
      pdf.text(`${index + 1}. Violation: ${violation.violation_type.replace(/_/g, ' ').toUpperCase()}`, 25, yPos);
      
      pdf.setFontSize(9);
      pdf.setTextColor(100, 100, 100);
      pdf.text(`Time: ${new Date(violation.timestamp).toLocaleString()}`, 25, yPos + 6);
      pdf.text(`Severity: ${violation.severity.toUpperCase()}`, 25, yPos + 11);
      
      if (violation.details?.message) {
        pdf.text(`Details: ${violation.details.message}`, 25, yPos + 16);
      }
      
      // Add evidence image if available
      if (violation.image_url) {
        try {
          // Add a small thumbnail with tag
          pdf.setFontSize(8);
          pdf.setTextColor(220, 38, 38);
          pdf.text('📷 Evidence Photo Captured', 25, yPos + 22);
          pdf.setTextColor(100, 100, 100);
          pdf.text(`Type: ${violation.violation_type.replace(/_/g, ' ')}`, 25, yPos + 27);
          pdf.text(`Timestamp: ${new Date(violation.timestamp).toLocaleString()}`, 25, yPos + 32);
          
          // Note: jsPDF requires image to be loaded first for embedding
          // For now, we'll just reference the URL
          pdf.setFontSize(7);
          pdf.setTextColor(0, 0, 255);
          pdf.textWithLink('View Evidence Image', 25, yPos + 37, { url: violation.image_url });
          
          yPos += 45;
        } catch (error) {
          console.error('Error adding image to PDF:', error);
          yPos += 25;
        }
      } else {
        // Show that no evidence was captured for this violation
        pdf.setFontSize(8);
        pdf.setTextColor(150, 150, 150);
        pdf.text('No evidence image captured', 25, yPos + 22);
        yPos += 30;
      }
    }
    
    // Footer note about evidence
    pdf.addPage();
    pdf.setFontSize(10);
    pdf.setTextColor(0, 0, 0);
    pdf.text('Evidence Images:', 20, 20);
    pdf.setFontSize(9);
    pdf.setTextColor(100, 100, 100);
    pdf.text('All violation evidence images are stored securely in the system.', 20, 28);
    pdf.text('Click on the blue "View Evidence Image" links above to access snapshots.', 20, 34);
    
    let evidenceYPos = 44;
    violationsArray.filter(v => v && v.image_url).forEach((violation, idx) => {
      if (evidenceYPos > 270) {
        pdf.addPage();
        evidenceYPos = 20;
      }
      pdf.setFontSize(8);
      pdf.setTextColor(0, 0, 0);
      pdf.text(`${idx + 1}. ${violation.violation_type.replace(/_/g, ' ')}`, 25, evidenceYPos);
      pdf.setTextColor(0, 0, 255);
      pdf.textWithLink('Open Image', 80, evidenceYPos, { url: violation.image_url });
      evidenceYPos += 7;
    });
    
    // Generate PDF blob
    const pdfBlob = pdf.output('blob');
    
    // Upload to Supabase Storage with better error handling
    // Sanitize studentName and studentId to avoid path issues
    const sanitizedName = safeStudentName.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
    const sanitizedId = safeStudentId.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
    const fileName = `${sanitizedName}_${sanitizedId}/reports/violation_report_${Date.now()}.pdf`;
    
    try {
      // First try to upload to Supabase
      const { data, error } = await supabase.storage
        .from('exam-reports')
        .upload(fileName, pdfBlob, {
          cacheControl: '3600',
          upsert: true  // Allow overwrite if file exists
        });

      if (error) {
        console.warn('Supabase upload failed, using local download:', error);
        throw new Error('Upload failed');
      }

      const { data: { publicUrl } } = supabase.storage
        .from('exam-reports')
        .getPublicUrl(fileName);

      return publicUrl;
    } catch (uploadError) {
      console.log('Using local download fallback:', uploadError);
      // Fallback: create a local blob URL for immediate download
      try {
        const blobUrl = URL.createObjectURL(pdfBlob);
        const link = document.createElement('a');
        link.href = blobUrl;
        const sanitizedName = safeStudentName.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
        const sanitizedId = safeStudentId.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
        link.download = `${sanitizedName}_${sanitizedId}_report_${Date.now()}.pdf`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        // Clean up the blob URL after a delay (but keep it available for a bit longer)
        setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
        
        // Return the blob URL so it can be opened if needed
        return blobUrl;
      } catch (downloadError) {
        console.error('Local download also failed:', downloadError);
        // If local download fails, throw an error
        const errorMessage = downloadError instanceof Error ? downloadError.message : String(downloadError) || 'Unknown error';
        throw new Error(`Failed to download PDF: ${errorMessage}`);
      }
    }
    } catch (error) {
      console.error('PDF generation failed:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to generate PDF report: ${errorMessage}`);
    }
  }

  async exportToCSV(violations: ViolationData[]): Promise<string> {
    const headers = [
      'Timestamp', 
      'Student ID', 
      'Student Name', 
      'Subject Name', 
      'Subject Code', 
      'Violation Type', 
      'Severity', 
      'Details', 
      'Confidence', 
      'Evidence Image URL', 
      'Has Evidence'
    ];
    
    console.log('CSV Export - Processing violations:', violations.length);
    console.log('CSV Export - Sample violation:', violations[0]);
    
    const rows = violations.map(v => {
      // Extract student info from multiple possible sources
      const studentId = v.details?.student_id || v.details?.studentId || 'ID Not Available';
      const studentName = v.details?.student_name || v.details?.studentName || 'Name Not Available';
      const subjectName = v.details?.subject_name || v.details?.subjectName || 'Subject Not Available';
      const subjectCode = v.details?.subject_code || v.details?.subjectCode || 'Code Not Available';
      
      return [
        new Date(v.timestamp).toLocaleString(),
        studentId,
        studentName,
        subjectName,
        subjectCode,
        v.violation_type.replace(/_/g, ' '),
        v.severity,
        v.details?.message || 'No details available',
        v.details?.confidence ? `${(v.details.confidence * 100).toFixed(1)}%` : 'N/A',
        v.image_url || 'No evidence captured',
        v.image_url ? 'Yes' : 'No'
      ];
    });
    
    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    ].join('\n');
    
    console.log('CSV Export - Generated CSV with', rows.length, 'rows');
    return csvContent;
  }
}

export const pdfGenerator = new PDFGenerator();
