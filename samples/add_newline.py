#!/usr/bin/env python3
"""
Script to add a new line after #%% lines in all .chat.md files.
"""

import os
import re
import glob
import sys

def process_file(file_path):
    """Process a file to add a newline after #%% lines."""
    print(f"Processing: {file_path}")
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Pattern to match #%% lines that are not already followed by two newlines
    pattern = r'(#%%[^\n]*\n)(?!\n)'
    
    # Replace with the matched line plus an extra newline
    modified_content = re.sub(pattern, r'\1\n', content)
    
    # Only write back if changes were made
    if content != modified_content:
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(modified_content)
        print(f"  Added newlines to {file_path}")
    else:
        print(f"  No changes needed for {file_path}")

def main():
    """Main function to process all .chat.md files in specified directory."""
    # Get the directory from the user or use the default
    samples_dir = '/Users/arusia/repos/filechat/samples'
    
    # Find all .chat.md files
    chat_files = glob.glob(os.path.join(samples_dir, '*.chat.md'))
    
    if not chat_files:
        print(f"No .chat.md files found in {samples_dir}")
        return
    
    print(f"Found {len(chat_files)} .chat.md files to process")
    
    # Process each file
    for file_path in chat_files:
        process_file(file_path)
    
    print("Processing complete!")

if __name__ == "__main__":
    main()
