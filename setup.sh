#!/bin/bash
# Setup script for AutoHarvester Backend

set -e

echo "🚗 Setting up AutoHarvester Backend..."

# Create directory structure
mkdir -p src/config src/routes src/middleware src/services src/db/migrations src/types

# Initialize package.json
cat > package.json << 'EOF'
{
  "name": "autoharvester-backend",
  "version": "1.0.0",
  "description": "AutoHarvester API - Car market intelligence platform",
  "main": "dist/index.js",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:studio": "drizzle-kit studio",
    "lint": "eslint src --ext .ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "express": "^4.18.2",
    "cors": "^2.8.5",
    "helmet": "^7.1.0",
    "express-rate-limit": "^7.1.5",
    "express-session": "^1.17.3",
    "passport": "^0.7.0",
    "passport-local": "^1.0.0",
    "bcrypt": "^5.1.1",
    "zod": "^3.22.4",
    "drizzle-orm": "^0.29.3",
    "pg": "^8.11.3",
    "stripe": "^14.10.0",
    "dotenv": "^16.3.1",
    "uuid": "^9.0.1"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/cors": "^2.8.17",
    "@types/express-session": "^1.17.10",
    "@types/passport": "^1.0.16",
    "@types/passport-local": "^1.0.38",
    "@types/bcrypt": "^5.0.2",
    "@types/pg": "^8.10.9",
    "@types/uuid": "^9.0.7",
    "@types/node": "^20.10.6",
    "typescript": "^5.3.3",
    "tsx": "^4.7.0",
    "drizzle-kit": "^0.20.10",
    "eslint": "^8.56.0",
    "@typescript-eslint/eslint-plugin": "^6.16.0",
    "@typescript-eslint/parser": "^6.16.0"
  },
  "engines": {
    "node": ">=20.0.0"
  }
}
EOF

echo "✅ package.json created"

# TypeScript configuration
cat > tsconfig.json << 'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "moduleResolution": "node",
    "allowSyntheticDefaultImports": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
EOF

echo "✅ tsconfig.json created"

# Drizzle configuration
cat > drizzle.config.ts << 'EOF'
import type { Config } from 'drizzle-kit';
import * as dotenv from 'dotenv';

dotenv.config();

export default {
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  driver: 'pg',
  dbCredentials: {
    connectionString: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: true,
} satisfies Config;
EOF

echo "✅ drizzle.config.ts created"

# Environment template
cat > .env.template << 'EOF'
# Database
DATABASE_URL=postgresql://username:password@host/database

# Stripe
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PRO_MONTHLY=price_...
STRIPE_PRICE_PRO_YEARLY=price_...
STRIPE_PRICE_DEALER_MONTHLY=price_...
STRIPE_PRICE_DEALER_YEARLY=price_...

# Security
JWT_SECRET=your-jwt-secret-min-32-chars
SESSION_SECRET=your-session-secret-min-32-chars

# App
FRONTEND_URL=https://autoharvester.com.au
PORT=3001
NODE_ENV=development
EOF

echo "✅ .env.template created"

echo "📦 Installing dependencies..."
npm install

echo "✅ AutoHarvester Backend setup complete!"
echo ""
echo "Next steps:"
echo "1. Copy .env.template to .env and fill in your values"
echo "2. Run 'npm run db:generate' to create migrations"
echo "3. Run 'npm run db:migrate' to apply migrations"
echo "4. Run 'npm run dev' to start the development server"
EOF
