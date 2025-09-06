import { BatchedWriter, getBatchedWriter, closeAllBatchedWriters } from "../utils/batchedWriter";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("BatchedWriter", () => {
  let testDir: string;
  let testFilePath: string;

  beforeEach(() => {
    // Create a temporary test directory
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "batched-writer-test-"));
    testFilePath = path.join(testDir, "test.log");
  });

  afterEach(() => {
    // Clean up test files
    try {
      if (fs.existsSync(testFilePath)) {
        fs.unlinkSync(testFilePath);
      }
      if (fs.existsSync(testDir)) {
        fs.rmdirSync(testDir);
      }
    } catch (error) {
      // Ignore cleanup errors
    }
    
    // Close all batched writers
    closeAllBatchedWriters();
  });

  test("should create file and write content", () => {
    const writer = new BatchedWriter(testFilePath);
    const testContent = "test content";
    
    writer.add(testContent);
    writer.flush();
    writer.close();
    
    expect(fs.existsSync(testFilePath)).toBe(true);
    const content = fs.readFileSync(testFilePath, "utf8");
    expect(content).toBe(testContent);
  });

  test("should batch multiple writes", () => {
    const writer = new BatchedWriter(testFilePath, { maxBatchSize: 3 });
    
    writer.add("content1");
    writer.add("content2");
    writer.add("content3"); // Should trigger flush
    
    // Wait a bit for async operations
    setTimeout(() => {
      expect(fs.existsSync(testFilePath)).toBe(true);
      const content = fs.readFileSync(testFilePath, "utf8");
      expect(content).toBe("content1content2content3");
    }, 100);
    
    writer.close();
  });

  test("should flush on close", () => {
    const writer = new BatchedWriter(testFilePath, { flushOnClose: true });
    
    writer.add("content1");
    writer.add("content2");
    writer.close(); // Should flush remaining content
    
    expect(fs.existsSync(testFilePath)).toBe(true);
    const content = fs.readFileSync(testFilePath, "utf8");
    expect(content).toBe("content1content2");
  });

  test("should get existing writer for same file", () => {
    const writer1 = getBatchedWriter(testFilePath);
    const writer2 = getBatchedWriter(testFilePath);
    
    expect(writer1).toBe(writer2);
    
    writer1.close();
  });

  test("should handle errors gracefully", () => {
    // Try to write to a directory (which should fail)
    const invalidPath = testDir; // This is a directory, not a file
    
    expect(() => {
      const writer = new BatchedWriter(invalidPath);
      writer.add("test");
      writer.flush();
      writer.close();
    }).not.toThrow();
  });
});
