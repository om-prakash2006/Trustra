/**
 * Firestore integration using Firebase Admin SDK.
 * Connected to AI Studio provisioned Cloud Firestore.
 * Follows strict privacy-first persistence.
 */

import fs from 'fs';
import path from 'path';
import { initializeApp, getApps, type App } from 'firebase-admin/app';
import { getFirestore, FieldValue, Firestore } from 'firebase-admin/firestore';
import { logger } from '../utils/logger.ts';
import type { AnalysisResult } from '../schemas/analysis.ts';

let db: Firestore | null = null;
let firestoreAvailable = false;
let configuredDatabaseId: string | undefined;

// In-memory cache for ultra-fast local retrieval & redundancy
const volatileAnalyses = new Map<string, Record<string, unknown>>();
const volatileVerifications = new Map<string, Record<string, unknown>[]>();
const volatileSessions = new Map<string, { lastActive: string; count: number }>();

try {
  let firebaseConfig: { projectId?: string; firestoreDatabaseId?: string } = {};
  const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');

  if (fs.existsSync(configPath)) {
    firebaseConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }

  const projectId = firebaseConfig.projectId;
  configuredDatabaseId = firebaseConfig.firestoreDatabaseId;

  let app: App;
  if (!getApps().length) {
    app = initializeApp(projectId ? { projectId } : undefined);
  } else {
    app = getApps()[0]!;
  }

  // Connect to the specific provisioned Firestore database instance
  if (configuredDatabaseId) {
    db = getFirestore(app, configuredDatabaseId);
  } else {
    db = getFirestore(app);
  }

  firestoreAvailable = true;
  logger.info('Firebase Admin successfully connected to Cloud Firestore', {
    projectId,
    databaseId: configuredDatabaseId || '(default)',
  });
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  logger.warn('Firestore initialization failed; volatile fallback enabled', { error: msg });
  firestoreAvailable = false;
  db = null;
}

export interface StoredAnalysisRecord {
  analysisId: string;
  createdAt: string;
  inputType: 'text' | 'image' | 'voice';
  language: string;
  riskLevel: string;
  riskScore: number;
  confidence: number;
  summary: string;
  signals: unknown[];
  claims: unknown[];
  evidenceStatus: string;
  simpleExplanation: string;
  safeActions: unknown[];
}

export const firestoreService = {
  isAvailable(): boolean {
    return firestoreAvailable && db !== null;
  },

  getDatabaseInfo(): { available: boolean; databaseId?: string } {
    return {
      available: this.isAvailable(),
      databaseId: configuredDatabaseId,
    };
  },

  async saveAnalysis(
    analysis: AnalysisResult,
    inputType: 'text' | 'image' | 'voice' = 'text',
    language = 'en'
  ): Promise<void> {
    const record: StoredAnalysisRecord = {
      analysisId: analysis.analysisId,
      createdAt: new Date().toISOString(),
      inputType,
      language,
      riskLevel: analysis.riskLevel,
      riskScore: analysis.riskScore,
      confidence: analysis.confidence,
      summary: analysis.summary,
      signals: analysis.signals,
      claims: analysis.claims,
      evidenceStatus: analysis.evidenceStatus,
      simpleExplanation: analysis.simpleExplanation,
      safeActions: analysis.safeActions,
      // PRIVACY RULE: NEVER store raw message or raw screenshots
    };

    volatileAnalyses.set(analysis.analysisId, record as unknown as Record<string, unknown>);

    if (db && firestoreAvailable) {
      try {
        await db.collection('analyses').doc(analysis.analysisId).set(record);
        logger.info('Analysis safely written to Cloud Firestore', { analysisId: analysis.analysisId });
      } catch (error) {
        logger.warn('Firestore write encountered error, preserved in memory', {
          analysisId: analysis.analysisId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  },

  async getAnalysis(analysisId: string): Promise<Record<string, unknown> | null> {
    if (db && firestoreAvailable) {
      try {
        const doc = await db.collection('analyses').doc(analysisId).get();
        if (doc.exists) {
          return doc.data() || null;
        }
      } catch {
        // Fall back to memory
      }
    }
    return volatileAnalyses.get(analysisId) || null;
  },

  async saveVerificationResults(
    analysisId: string,
    results: Array<{
      claim: string;
      status: string;
      explanation: string;
      sources: Array<{ title: string; url: string }>;
    }>
  ): Promise<void> {
    const payload = results.map((r) => ({
      ...r,
      analysisId,
      createdAt: new Date().toISOString(),
    }));

    volatileVerifications.set(analysisId, payload);

    if (db && firestoreAvailable) {
      try {
        const batch = db.batch();
        for (const item of payload) {
          const docRef = db.collection('verification_results').doc();
          batch.set(docRef, item);
        }
        await batch.commit();
        logger.info('Verification results safely written to Cloud Firestore', {
          analysisId,
          count: payload.length,
        });
      } catch (error) {
        logger.warn('Firestore verification write encountered error', {
          analysisId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  },

  async recordSession(sessionId: string): Promise<void> {
    const now = new Date().toISOString();
    const current = volatileSessions.get(sessionId) || { lastActive: now, count: 0 };
    current.lastActive = now;
    current.count += 1;
    volatileSessions.set(sessionId, current);

    if (db && firestoreAvailable) {
      try {
        await db.collection('sessions').doc(sessionId).set(
          {
            lastActive: now,
            requestCount: FieldValue.increment(1),
          },
          { merge: true }
        );
      } catch {
        // Silently swallow anonymous session errors
      }
    }
  },
};
