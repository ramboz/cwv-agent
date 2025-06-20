# Exact AI Chat Commands for CWV Suggestion Review

This guide shows the **exact messages** to use in Cursor's AI Chat for reviewing CWV suggestions.

## Prerequisites

1. Set up Cursor Custom Mode called "CWV Review" using `cursor-cwv-mode.md`
2. Have generated a `.suggestions.json` file from cwv-agent
3. Switch to "CWV Review" mode in Cursor

---

## 🎯 **Step-by-Step Chat Flow**

### Step 1: Load and Review Suggestions

**Your message:**
```
Load suggestions from .cache/www-ups-com-lasso-ulError.mobile.suggestions.gemini25pro.json
```

**AI will respond with:**
- Summary of all suggestions grouped by priority (High/Medium/Low)
- Total count and site information
- List of suggestions with metrics and effort estimates

### Step 2: Get More Details (Optional)

**Your message:**
```
Show me suggestion 1 details
```
OR
```
What are all the high priority suggestions?
```

**AI will show:**
- Full details for specific suggestions
- Implementation details and code examples
- Expected impact metrics

### Step 3: Edit a Suggestion

**Your message:**
```
Edit suggestion 1
```

**AI will:**
- Create a markdown file in `temp-edits/`
- Show you the file path
- Tell you to edit and save when ready

**Example AI response:**
```
Created editor for suggestion 1: temp-edits/suggestion-1-2024-12-20T10-30-15-123Z.md

Please edit this file in Cursor and save your changes. When you're done, tell me "I've finished editing suggestion 1"
```

### Step 4: Process Your Edits

**After editing and saving the markdown file, your message:**
```
I've finished editing suggestion 1
```
OR
```
Read my changes from suggestion 1
```

**AI will:**
- Parse your markdown edits
- Show you what changed
- Ask for approval to proceed

### Step 5: Approve and Upload

**Your message:**
```
Approve and upload suggestion 1 to SpaceCat
```
OR for testing:
```
Dry run upload for suggestion 1
```

**AI will:**
- Upload to SpaceCat (or simulate if dry run)
- Confirm the upload
- Show the uploaded suggestion details

### Step 6: Batch Operations (Optional)

**Your message:**
```
Edit suggestions 2 and 3
```
```
Upload all approved suggestions
```
```
Show me current progress
```

### Step 7: Clean Up

**Your message:**
```
Clean up temporary files
```

**AI will:**
- Remove all temporary markdown files
- Confirm cleanup
- Show final summary

---

## 📋 **Complete Example Session**

Here's a **real conversation** you can follow:

### User:
```
Load suggestions from .cache/www-ups-com-lasso-ulError.mobile.suggestions.gemini25pro.json
```

### AI Response:
```
🎯 **CWV Suggestions Loaded**
Found 10 suggestions for https://www.ups.com/lasso/ulError (mobile)

**High Priority (3):**
1. Optimize Synchronous `<head>` Scripts - LCP impact: 5-10s reduction
2. Optimize and Defer Legacy/Unused CSS - LCP impact: 3-7s reduction  
3. Address Critical Long Animation Frame - INP impact: 300ms+ reduction

**Medium Priority (6):**
4. Preload Critical Rendering Assets - LCP impact: 500ms-1s reduction
5. Optimize Font Loading and Rendering - LCP impact: 300-800ms reduction
... (and 4 more)

**Low Priority (1):**
8. Implement scrollbar-gutter: stable - CLS impact: <0.01 reduction

Which suggestion would you like to review or edit first?
```

### User:
```
Edit suggestion 1
```

### AI Response:
```
📝 **Creating Editor for Suggestion 1**

Created: temp-edits/suggestion-1-2024-12-20T10-30-15-123Z.md

This file contains:
- Title: Optimize Synchronous `<head>` Scripts
- Current Priority: High
- Current Effort: Medium
- Full implementation details

Please edit this markdown file in Cursor and save your changes. 
When finished, tell me "I've finished editing suggestion 1"
```

### User: *(edits file, saves, then types)*
```
I've finished editing suggestion 1
```

### AI Response:
```
✅ **Processed Your Edits**

Changes detected in suggestion 1:
- Priority: High → Critical  
- Description: Added "CRITICAL ISSUE:" prefix
- Implementation: No changes
- Notes: Added deployment timeline

Ready to upload this edited suggestion to SpaceCat?
```

### User:
```
Yes, upload suggestion 1 to SpaceCat
```

### AI Response:
```
✅ **Uploaded to SpaceCat**

Successfully uploaded suggestion 1:
- Title: Optimize Synchronous `<head>` Scripts  
- Priority: Critical
- Expected Impact: LCP 5-10s reduction
- SpaceCat ID: SPC-12345

Cleaned up temporary file. Ready for next suggestion?
```

### User:
```
Show me current progress
```

### AI Response:
```
📊 **Current Progress**

Total Suggestions: 10
- Uploaded: 1
- In Progress: 0  
- Remaining: 9

**Next Recommended:**
2. Optimize and Defer Legacy/Unused CSS (High priority, Medium effort)

Would you like to edit this one next?
```

---

## 🔧 **Useful Chat Commands**

### Loading and Overview
```
Load suggestions from [filepath]
Show me all suggestions
What are the high priority items?
Show me suggestion [number] details
```

### Editing
```
Edit suggestion [number]
Create editor for the [description] suggestion
I've finished editing suggestion [number]
Read my changes from suggestion [number]
```

### Approval and Upload
```
Approve suggestion [number]
Upload suggestion [number] to SpaceCat
Dry run upload for suggestion [number]
Upload all approved suggestions
```

### Status and Management
```
Show me current progress
How many suggestions are ready?
What's the biggest impact suggestion?
Clean up temporary files
Give me a final summary
```

### Batch Operations
```
Edit suggestions 1, 3, and 5
Show me all LCP suggestions
Upload the top 3 high priority suggestions
Mark suggestions 2 and 4 as approved
```

---

## 💡 **Pro Tips**

1. **Be Specific**: "Edit suggestion 1" is better than "edit the first one"

2. **Natural Language Works**: 
   - "Show me the font loading suggestion"
   - "What's the biggest LCP improvement we can get?"
   - "Edit the CSS suggestion"

3. **Batch Commands**:
   - "Edit suggestions 1 through 3"
   - "Upload all high priority suggestions"

4. **Always Dry Run First**:
   - "Dry run upload for suggestion 1" before real uploads

5. **Check Progress**:
   - "Show me current progress" to see what's done

6. **Use Context**:
   - "Edit that suggestion" (referring to previously discussed one)
   - "Upload it" (referring to current suggestion)

This workflow lets you **manage 10+ suggestions in just a few minutes** instead of the previous manual 1-by-1 process! 🚀 