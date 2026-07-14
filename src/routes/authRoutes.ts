// src/routes/authRoutes.ts
import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticateToken } from '../middleware/auth';
import { validateSendingAddress } from '../lib/sellerAddress';
import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  InitiateAuthCommand,
  AuthFlowType,
  ConfirmSignUpCommand,
  AdminConfirmSignUpCommand,
  ForgotPasswordCommand,
  ConfirmForgotPasswordCommand,
  ChangePasswordCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { sendVerificationEmail, sendPasswordResetEmail, sendWelcomeEmail } from '../services/emailService';
import crypto from 'crypto';
import { buildTokenResponse, hashToken, signAccessToken, wantsRefresh } from '../lib/tokens';

if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set. Exiting.');
  process.exit(1);
}

const router = Router();

const cognitoClient = new CognitoIdentityProviderClient({
  region: process.env.AWS_REGION || 'eu-west-2',
});

// Generate 6-digit code
function generateVerificationCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Rate limiter: 5 login attempts per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many login attempts, please try again in 15 minutes',
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter: 3 signups per hour per IP
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: 'Too many accounts created from this IP. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Register a new user
 */
router.post('/register', signupLimiter, async (req: Request, res: Response) => {
  try {
    const { email: rawEmail, password, display_name, phone_number, marketing_emails } = req.body;
const email = rawEmail?.trim().toLowerCase();

    const VALID_PLATFORMS = ['ios', 'android', 'web'];
    const rawPlatform = typeof req.body.signup_platform === 'string'
      ? req.body.signup_platform.trim().toLowerCase()
      : null;
    const signup_platform = rawPlatform && VALID_PLATFORMS.includes(rawPlatform) ? rawPlatform : null;

    console.log('📝 Registering user:', email);

    // Create user in Cognito (but skip their email verification)
    const signUpCommand = new SignUpCommand({
      ClientId: process.env.COGNITO_CLIENT_ID!,
      Username: email,
      Password: password,
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'name', Value: display_name },
      ],
    });

    const cognitoResponse = await cognitoClient.send(signUpCommand);

    if (!cognitoResponse.UserSub) {
      return res.status(500).json({ error: 'Failed to get user ID from Cognito' });
    }

    console.log('✅ Cognito user created:', cognitoResponse.UserSub);

    // Generate our own verification code
    const verificationCode = generateVerificationCode();
    const codeExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    // Check if user already exists in database
    const existingUser = await prisma.users.findFirst({
      where: { email },
    });

    let user;

    if (existingUser) {
      console.log('⚠️ User already exists in database, updating Cognito ID');
      user = await prisma.users.update({
        where: { id: existingUser.id },
        data: {
          cognito_id: cognitoResponse.UserSub,
          verification_code: verificationCode,
          verification_code_expires: codeExpires,
          updated_at: new Date(),
          ...(signup_platform && !existingUser.signup_platform ? { signup_platform } : {}),
        },
      });
    } else {
      user = await prisma.users.create({
        data: {
          id: `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          cognito_id: cognitoResponse.UserSub,
          email,
          display_name: display_name,
          phone: phone_number || null,
          verification_code: verificationCode,
          verification_code_expires: codeExpires,
          created_at: new Date(),
          updated_at: new Date(),
          marketing_emails: marketing_emails || false,
            sms_marketing_consent: req.body.sms_marketing_consent || false,
            signup_platform,
        },
      });
    }

    console.log('✅ Database user created:', user.id);

    // Send verification email via Resend
    try {
      await sendVerificationEmail(email, verificationCode);
      console.log('📧 Verification email sent to:', email);
    } catch (emailError) {
      console.error('❌ Failed to send verification email:', emailError);
      // Don't fail registration if email fails - user can request resend
    }

    res.status(201).json({
      message: 'Registration successful! Please check your email for a verification code.',
      email: email,
      user_id: user.id,
      requires_verification: true,
    });
  } catch (error: any) {
    console.error('❌ Registration error:', error);

    // Handle case where user already exists in Cognito
    if (error.name === 'UsernameExistsException') {
      console.log('⚠️ User already exists in Cognito, checking if unverified...');
      
      // Check if user exists in our database and is unverified
      const existingUser = await prisma.users.findFirst({
        where: { email: req.body.email?.trim().toLowerCase() },
      });

      if (existingUser && !existingUser.is_verified_seller) {
        console.log('📧 User is unverified, resending verification code...');
        
        // Generate new verification code
        const verificationCode = generateVerificationCode();
        const codeExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

        // Update user with new code
        await prisma.users.update({
          where: { id: existingUser.id },
          data: {
            verification_code: verificationCode,
            verification_code_expires: codeExpires,
            updated_at: new Date(),
          },
        });

        // Send new verification email
        try {
          await sendVerificationEmail(req.body.email?.trim().toLowerCase(), verificationCode);
console.log('📧 New verification email sent to:', req.body.email?.trim().toLowerCase());
        } catch (emailError) {
          console.error('❌ Failed to send verification email:', emailError);
        }

        // Return success - user can now verify with new code
        return res.status(200).json({
          message: 'A new verification code has been sent to your email.',
          email: req.body.email,
          user_id: existingUser.id,
          requires_verification: true,
        });
      }

      // User exists and is verified - they should log in instead
      return res.status(400).json({ error: 'An account with this email already exists. Please log in.' });
    }

    if (error.name === 'InvalidPasswordException') {
      return res.status(400).json({ error: 'Password must be at least 8 characters with uppercase, lowercase, and numbers' });
    }

    res.status(400).json({
      error: error.message || 'Registration failed',
    });
  }
});

/**
 * Verify email with code
 */
router.post('/verify-email', async (req: Request, res: Response) => {
  try {
    const { email: rawEmail, code } = req.body;
const email = rawEmail?.trim().toLowerCase();

    if (!email || !code) {
      return res.status(400).json({ error: 'Email and verification code are required' });
    }

    console.log('🔐 Verifying email:', email);

    // Find user and check code
    const user = await prisma.users.findFirst({
      where: { email },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if code matches and hasn't expired
    if (user.verification_code !== code.trim()) {
      return res.status(400).json({ error: 'Invalid verification code. Please check and try again.' });
    }

    if (user.verification_code_expires && new Date() > user.verification_code_expires) {
      return res.status(400).json({ error: 'Verification code has expired. Please request a new one.' });
    }

    // Confirm user in Cognito (admin confirm to bypass their email check)
    try {
      const confirmCommand = new AdminConfirmSignUpCommand({
        UserPoolId: process.env.COGNITO_USER_POOL_ID!,
        Username: email,
      });
      await cognitoClient.send(confirmCommand);
      console.log('✅ Cognito user confirmed');
    } catch (cognitoError: any) {
      // User might already be confirmed
      if (cognitoError.name !== 'NotAuthorizedException') {
        console.error('⚠️ Cognito confirm error:', cognitoError);
      }
    }

    // ✅ FIXED: Only clear verification code, do NOT set is_verified_seller to true
    // is_verified_seller is for SELLER VERIFICATION (the badge), not email verification
    // Email verification is tracked via Cognito confirmation status
    await prisma.users.update({
      where: { id: user.id },
      data: {
        verification_code: null,
        verification_code_expires: null,
        // ❌ REMOVED: is_verified_seller: true - this was giving new users the verified seller badge!
        updated_at: new Date(),
      },
    });

    console.log('✅ Email verified successfully:', email);

    // Send welcome email
    try {
      await sendWelcomeEmail(email, user.display_name || 'there');
      console.log('📧 Welcome email sent to:', email);
    } catch (emailError) {
      console.error('⚠️ Failed to send welcome email:', emailError);
    }

    // Auto-login after verification
    const tokens = await buildTokenResponse(
      { id: user.id, email: user.email, display_name: user.display_name },
      req,
    );

    res.json({
      message: 'Email verified successfully!',
      ...tokens,
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
      },
    });
  } catch (error: any) {
    console.error('❌ Verify email error:', error);
    res.status(400).json({
      error: error.message || 'Verification failed',
    });
  }
});

/**
 * Resend verification code
 */
router.post('/resend-verification', async (req: Request, res: Response) => {
  try {
    const { email: rawEmail } = req.body;
const email = rawEmail?.trim().toLowerCase();

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    console.log('📧 Resending verification code to:', email);

    const user = await prisma.users.findFirst({
      where: { email },
    });

    if (!user) {
      // Don't reveal if user exists
      return res.json({ message: 'If an account exists with this email, a new code has been sent.' });
    }

    // Generate new code
    const verificationCode = generateVerificationCode();
    const codeExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    await prisma.users.update({
      where: { id: user.id },
      data: {
        verification_code: verificationCode,
        verification_code_expires: codeExpires,
        updated_at: new Date(),
      },
    });

    // Send email
    try {
      await sendVerificationEmail(email, verificationCode);
      console.log('📧 Verification code resent to:', email);
    } catch (emailError) {
      console.error('❌ Failed to send verification email:', emailError);
      return res.status(500).json({ error: 'Failed to send verification email. Please try again.' });
    }

    res.json({ message: 'A new verification code has been sent to your email.' });
  } catch (error: any) {
    console.error('❌ Resend verification error:', error);
    res.status(400).json({
      error: error.message || 'Failed to resend verification code',
    });
  }
});

/**
 * Forgot Password - Request reset code
 */
router.post('/forgot-password', async (req: Request, res: Response) => {
  try {
    const { email: rawEmail } = req.body;
const email = rawEmail?.trim().toLowerCase();

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    console.log('🔐 Password reset requested for:', email);

    // Check if user exists
    const user = await prisma.users.findFirst({
      where: { email },
    });

    if (!user) {
      // Don't reveal if user exists - security best practice
      return res.json({ message: 'If an account exists with this email, a password reset code has been sent.' });
    }

    // Generate reset code
    const resetCode = generateVerificationCode();
    const codeExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Save to database
    await prisma.users.update({
      where: { id: user.id },
      data: {
        password_reset_code: resetCode,
        password_reset_code_expires: codeExpires,
        updated_at: new Date(),
      },
    });

    // Send reset email
    try {
      await sendPasswordResetEmail(email, resetCode);
      console.log('📧 Password reset email sent to:', email);
    } catch (emailError) {
      console.error('❌ Failed to send password reset email:', emailError);
      return res.status(500).json({ error: 'Failed to send reset email. Please try again.' });
    }

    res.json({ message: 'If an account exists with this email, a password reset code has been sent.' });
  } catch (error: any) {
    console.error('❌ Forgot password error:', error);
    res.status(400).json({
      error: error.message || 'Failed to process password reset request',
    });
  }
});

/**
 * Reset Password - Use reset code to set new password
 */
router.post('/reset-password', async (req: Request, res: Response) => {
  try {
    const { email: rawEmail, code, password } = req.body;
const email = rawEmail?.trim().toLowerCase();

    if (!email || !code || !password) {
      return res.status(400).json({ error: 'Email, code, and new password are required' });
    }

    console.log('🔐 Resetting password for:', email);

    // Find user and verify code
    const user = await prisma.users.findFirst({
      where: { email },
    });

    if (!user) {
      return res.status(400).json({ error: 'Invalid reset code.' });
    }

    if (user.password_reset_code !== code.trim()) {
      return res.status(400).json({ error: 'Invalid reset code. Please check and try again.' });
    }

    if (user.password_reset_code_expires && new Date() > user.password_reset_code_expires) {
      return res.status(400).json({ error: 'Reset code has expired. Please request a new one.' });
    }

    // Use Cognito's forgot password flow to actually change the password
    // First trigger Cognito's forgot password
    const forgotCommand = new ForgotPasswordCommand({
      ClientId: process.env.COGNITO_CLIENT_ID!,
      Username: email,
    });
    await cognitoClient.send(forgotCommand);

    // Wait a moment for Cognito to process
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Now we need to use AdminSetUserPassword instead since we can't intercept Cognito's code
    // Actually, let's use a different approach - AdminSetUserPassword
    const { AdminSetUserPasswordCommand } = await import('@aws-sdk/client-cognito-identity-provider');
    
    const setPasswordCommand = new AdminSetUserPasswordCommand({
      UserPoolId: process.env.COGNITO_USER_POOL_ID!,
      Username: email,
      Password: password,
      Permanent: true,
    });
    
    await cognitoClient.send(setPasswordCommand);

    // Clear reset code
    await prisma.users.update({
      where: { id: user.id },
      data: {
        password_reset_code: null,
        password_reset_code_expires: null,
        updated_at: new Date(),
      },
    });

    console.log('✅ Password reset successful for:', email);

    res.json({
      message: 'Password reset successfully!',
    });
  } catch (error: any) {
    console.error('❌ Reset password error:', error);

    if (error.name === 'InvalidPasswordException') {
      return res.status(400).json({ error: 'Password must be at least 8 characters with uppercase, lowercase, numbers, and special characters' });
    }

    res.status(400).json({
      error: error.message || 'Failed to reset password',
    });
  }
});

/**
 * Change Password - For logged-in users
 */
router.post('/change-password', authenticateToken, async (req: any, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user.sub || req.user.id;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }

    const user = await prisma.users.findUnique({
      where: { id: userId },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    console.log('🔐 Changing password for:', user.email);

    // Authenticate with current password
    const authCommand = new InitiateAuthCommand({
      ClientId: process.env.COGNITO_CLIENT_ID!,
      AuthFlow: AuthFlowType.USER_PASSWORD_AUTH,
      AuthParameters: {
        USERNAME: user.email,
        PASSWORD: currentPassword,
      },
    });

    const authResult = await cognitoClient.send(authCommand);

    if (!authResult.AuthenticationResult) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Change the password
    const changeCommand = new ChangePasswordCommand({
      PreviousPassword: currentPassword,
      ProposedPassword: newPassword,
      AccessToken: authResult.AuthenticationResult.AccessToken!,
    });

    await cognitoClient.send(changeCommand);

    console.log('✅ Password changed successfully for:', user.email);

    res.json({
      message: 'Password changed successfully!',
    });
  } catch (error: any) {
    console.error('❌ Change password error:', error);

    if (error.name === 'NotAuthorizedException') {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    if (error.name === 'InvalidPasswordException') {
      return res.status(400).json({ error: 'New password must be at least 8 characters with uppercase, lowercase, numbers, and special characters' });
    }

    res.status(400).json({
      error: error.message || 'Failed to change password',
    });
  }
});

/**
 * Login user
 */
router.post('/login', loginLimiter, async (req: Request, res: Response) => {
  try {
    const { email: rawEmail, password } = req.body;
const email = rawEmail?.trim().toLowerCase();

    console.log('🔑 Login attempt for:', email);

    const user = await prisma.users.findFirst({
      where: { email },
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Authenticate with Cognito
    const authCommand = new InitiateAuthCommand({
      ClientId: process.env.COGNITO_CLIENT_ID!,
      AuthFlow: AuthFlowType.USER_PASSWORD_AUTH,
      AuthParameters: {
        USERNAME: email,
        PASSWORD: password,
      },
    });

    const authResult = await cognitoClient.send(authCommand);

    if (!authResult.AuthenticationResult) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    console.log('✅ Login successful:', email);

    // Backfill signup_platform for existing users
    const LOGIN_VALID_PLATFORMS = ['ios', 'android', 'web'];
    const loginPlatform = typeof req.body.signup_platform === 'string'
      ? req.body.signup_platform.trim().toLowerCase()
      : null;
    if (!user.signup_platform && loginPlatform && LOGIN_VALID_PLATFORMS.includes(loginPlatform)) {
      await prisma.users.update({
        where: { id: user.id },
        data: { signup_platform: loginPlatform },
      });
    }

    const tokens = await buildTokenResponse(
      { id: user.id, email: user.email, display_name: user.display_name },
      req,
    );

    res.json({
      ...tokens,
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
      },
    });
  } catch (error: any) {
    console.error('❌ Login error:', error);

    if (error.name === 'UserNotConfirmedException') {
      return res.status(403).json({
        error: 'Please verify your email before logging in',
        requires_verification: true,
        email: req.body.email,
      });
    }

    res.status(401).json({
      error: error.message || 'Login failed',
    });
  }
});

/**
 * Get current user profile
 */
router.get('/profile', authenticateToken, async (req: any, res: Response) => {
  try {
    const userId = req.user.sub || req.user.id;

    const user = await prisma.users.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        display_name: true,
        avatar_url: true,
        bio: true,
        rating: true,
        location: true,
        created_at: true,
        sending_address: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

/**
 * Get current user's sending address
 */
router.get('/sending-address', authenticateToken, async (req: any, res: Response) => {
  try {
    const userId = req.user.sub || req.user.id;
    const user = await prisma.users.findUnique({
      where: { id: userId },
      select: { sending_address: true },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ sending_address: user.sending_address || null });
  } catch (error) {
    console.error('Get sending address error:', error);
    res.status(500).json({ error: 'Failed to get sending address' });
  }
});

/**
 * Save/update sending address (seller's sending + return address)
 */
router.put('/sending-address', authenticateToken, async (req: any, res: Response) => {
  try {
    const userId = req.user.sub || req.user.id;
    const { sending_address } = req.body;

    const validation = validateSendingAddress(sending_address);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    const sanitized = {
      name: (sending_address.name || '').trim().slice(0, 200),
      line1: sending_address.line1.trim().slice(0, 200),
      line2: sending_address.line2 ? sending_address.line2.trim().slice(0, 200) : null,
      city: sending_address.city.trim().slice(0, 100),
      postal_code: sending_address.postal_code.trim().toUpperCase().slice(0, 20),
      country: sending_address.country.trim().toUpperCase().slice(0, 2),
    };

    await prisma.users.update({
      where: { id: userId },
      data: {
        sending_address: sanitized,
        updated_at: new Date(),
      },
    });

    res.json({ success: true, sending_address: sanitized });
  } catch (error) {
    console.error('Update sending address error:', error);
    res.status(500).json({ error: 'Failed to update sending address' });
  }
});

// Rate limiter: 10 refresh attempts per 15 minutes per IP
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many refresh attempts, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Refresh access token using a valid refresh token.
 * Implements token rotation with reuse detection.
 */
router.post('/refresh', refreshLimiter, async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken || typeof refreshToken !== 'string' || refreshToken.length < 16) {
      return res.status(400).json({ error: 'refreshToken is required', code: 'REFRESH_MISSING' });
    }

    const tokenHash = hashToken(refreshToken);

    const row = await prisma.refresh_tokens.findUnique({
      where: { token_hash: tokenHash },
      include: { users: { select: { id: true, email: true, display_name: true, is_banned: true } } },
    });

    if (!row) {
      return res.status(401).json({ error: 'Invalid refresh token', code: 'REFRESH_INVALID' });
    }

    if (row.expires_at < new Date()) {
      return res.status(401).json({ error: 'Refresh token expired', code: 'REFRESH_INVALID' });
    }

    if (row.revoked_at) {
      await prisma.refresh_tokens.updateMany({
        where: { user_id: row.user_id, revoked_at: null },
        data: { revoked_at: new Date() },
      });
      console.log(`[AUTH] REFRESH_REUSE user=${row.user_id} token_id=${row.id}`);
      return res.status(401).json({ error: 'Refresh token reuse detected — all sessions revoked', code: 'REFRESH_REUSE' });
    }

    if (row.users.is_banned) {
      return res.status(403).json({ error: 'Account suspended', code: 'ACCOUNT_BANNED' });
    }

    // Atomic rotation: claim-the-row inside a transaction.
    // The conditional updateMany (revoked_at: null) prevents concurrent
    // requests from both succeeding — only one gets count=1.
    const rotation = await prisma.$transaction(async (tx: any) => {
      const claimed = await tx.refresh_tokens.updateMany({
        where: { id: row.id, revoked_at: null },
        data: { revoked_at: new Date() },
      });

      if (claimed.count === 0) {
        await tx.refresh_tokens.updateMany({
          where: { user_id: row.user_id, revoked_at: null },
          data: { revoked_at: new Date() },
        });
        return { reuse: true as const };
      }

      const rawToken = crypto.randomBytes(32).toString('hex');
      const newTokenHash = hashToken(rawToken);
      const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

      const newRow = await tx.refresh_tokens.create({
        data: {
          user_id: row.user_id,
          token_hash: newTokenHash,
          expires_at: expiresAt,
          user_agent: (req.headers['user-agent'] as string) || null,
        },
      });

      await tx.refresh_tokens.update({
        where: { id: row.id },
        data: { replaced_by: newRow.id },
      });

      return { reuse: false as const, rawToken, expiresAt };
    });

    if (rotation.reuse) {
      console.log(`[AUTH] REFRESH_REUSE (race) user=${row.user_id} token_id=${row.id}`);
      return res.status(401).json({ error: 'Refresh token reuse detected — all sessions revoked', code: 'REFRESH_REUSE' });
    }

    const accessToken = signAccessToken(
      { id: row.users.id, email: row.users.email, display_name: row.users.display_name },
      '1h',
    );

    res.json({
      accessToken,
      idToken: accessToken,
      refreshToken: rotation.rawToken,
      refreshExpiresAt: rotation.expiresAt.toISOString(),
    });
  } catch (error: any) {
    console.error('❌ Refresh token error:', error);
    res.status(500).json({ error: 'Failed to refresh token' });
  }
});

/**
 * Logout — revoke a refresh token (server-side session termination).
 * Always returns 200 (idempotent; does not leak whether the token existed).
 */
router.post('/logout', async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;

    if (refreshToken && typeof refreshToken === 'string' && refreshToken.length >= 16) {
      const tokenHash = hashToken(refreshToken);
      await prisma.refresh_tokens.updateMany({
        where: { token_hash: tokenHash, revoked_at: null },
        data: { revoked_at: new Date() },
      });
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error('❌ Logout error:', error);
    res.json({ success: true });
  }
});

export default router;