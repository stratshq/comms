import NextAuth, { type NextAuthConfig } from 'next-auth';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';
import GitHub from 'next-auth/providers/github';
import Nodemailer from 'next-auth/providers/nodemailer';
import bcrypt from 'bcryptjs';
import { eq } from '@comms/db';
import { loadConfig } from '@comms/core';
import { db } from './server/db';
import { users, accounts, sessions, verificationTokens } from '@comms/db';

const cfg = loadConfig();

/** Build the provider list from whatever the operator has configured. */
function buildProviders(): NextAuthConfig['providers'] {
  const providers: NextAuthConfig['providers'] = [
    Credentials({
      name: 'Email and password',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(creds) {
        const email = String(creds?.email ?? '')
          .trim()
          .toLowerCase();
        const password = String(creds?.password ?? '');
        if (!email || !password) return null;

        const user = await db.query.users.findFirst({ where: eq(users.email, email) });
        if (!user || !user.hashedPassword || user.status === 'disabled') return null;

        const ok = await bcrypt.compare(password, user.hashedPassword);
        if (!ok) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
        };
      },
    }),
  ];

  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    providers.push(
      Google({
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        allowDangerousEmailAccountLinking: true,
      }),
    );
  }

  if (process.env.GITHUB_ID && process.env.GITHUB_SECRET) {
    providers.push(
      GitHub({
        clientId: process.env.GITHUB_ID,
        clientSecret: process.env.GITHUB_SECRET,
        allowDangerousEmailAccountLinking: true,
      }),
    );
  }

  if (cfg.smtpEnabled) {
    providers.push(
      Nodemailer({
        server: {
          host: cfg.SMTP_HOST,
          port: cfg.SMTP_PORT ?? 587,
          auth:
            cfg.SMTP_USER && cfg.SMTP_PASSWORD
              ? { user: cfg.SMTP_USER, pass: cfg.SMTP_PASSWORD }
              : undefined,
        },
        from: cfg.SMTP_FROM,
      }),
    );
  }

  return providers;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  // Adapter persists users/accounts and magic-link verification tokens.
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  secret: cfg.authSecret,
  trustHost: true, // Railway assigns the host dynamically
  session: { strategy: 'jwt' },
  pages: { signIn: '/login' },
  providers: buildProviders(),
  callbacks: {
    // The token carries identity only. Authorization (role, permissions) is
    // read from the database per request — see `@/lib/session` — so a role
    // change applies immediately instead of at the next sign-in.
    async jwt({ token, user }) {
      if (user) token.id = user.id;
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        const id = token.id as string | undefined;
        if (id) session.user.id = id;
      }
      return session;
    },
  },
});
