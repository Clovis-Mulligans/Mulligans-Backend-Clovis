// src/routes/authRoutes.ts
import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticateToken } from '../middleware/auth';
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

const router = Router();
const prisma = new PrismaClient();

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
    const { email, password, display_name, phone_number } = req.body;

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
        },
      });
    }

    console.log('✅ Database user created:', user.id);

    // Send verification email via SendGrid
    try {
      await sendVerificationEmail(email, verificationCode);
      console.log('📧 Verification email sent via SendGrid to:', email);
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

    if (error.name === 'UsernameExistsException') {
      return res.status(400).json({ error: 'An account with this email already exists' });
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
    const { email, code } = req.body;

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

    // Clear verification code and mark as verified
    await prisma.users.update({
      where: { id: user.id },
      data: {
        verification_code: null,
        verification_code_expires: null,
        is_verified: true,
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

    // Create JWT token
    const token = jwt.sign(
      {
        userId: user.id,
        id: user.id,
        email: user.email,
        username: user.display_name,
        display_name: user.display_name,
      },
      process.env.JWT_SECRET!,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Email verified successfully!',
      accessToken: token,
      idToken: token,
      refreshToken: token,
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
      },
    });
  } catch (error: any) {
    console.error('❌ Verification error:', error);
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
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    console.log('📧 Resending verification code to:', email);

    // Find user
    const user = await prisma.users.findFirst({
      where: { email },
    });

    if (!user) {
      // Don't reveal if user exists
      return res.json({ message: 'If an account exists, a verification code has been sent.' });
    }

    // Generate new code
    const verificationCode = generateVerificationCode();
    const codeExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Update user with new code
    await prisma.users.update({
      where: { id: user.id },
      data: {
        verification_code: verificationCode,
        verification_code_expires: codeExpires,
        updated_at: new Date(),
      },
    });

    // Send email via SendGrid
    await sendVerificationEmail(email, verificationCode);
    console.log('✅ Verification code resent to:', email);

    res.json({
      message: 'Verification code sent! Please check your email.',
    });
  } catch (error: any) {
    console.error('❌ Resend error:', error);
    res.status(400).json({
      error: error.message || 'Failed to resend code',
    });
  }
});

/**
 * Forgot Password - Request reset code
 */
router.post('/forgot-password', async (req: Request, res: Response) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    console.log('🔐 Forgot password request for:', email);

    // Find user
    const user = await prisma.users.findFirst({
      where: { email },
    });

    if (!user) {
      // Don't reveal if user exists (security)
      return res.json({ message: 'If an account exists with this email, a reset code has been sent.' });
    }

    // Generate reset code
    const resetCode = generateVerificationCode();
    const codeExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Store reset code
    await prisma.users.update({
      where: { id: user.id },
      data: {
        password_reset_code: resetCode,
        password_reset_code_expires: codeExpires,
        updated_at: new Date(),
      },
    });

    // Send reset email via SendGrid
    await sendPasswordResetEmail(email, resetCode);
    console.log('✅ Password reset code sent to:', email);

    res.json({
      message: 'Password reset code sent! Please check your email.',
    });
  } catch (error: any) {
    console.error('❌ Forgot password error:', error);
    res.status(400).json({
      error: error.message || 'Failed to send reset code',
    });
  }
});

/**
 * Reset Password - Confirm with code and set new password
 */
router.post('/reset-password', async (req: Request, res: Response) => {
  try {
    const { email, code, password } = req.body;

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
    const { email, password } = req.body;

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

    // Create JWT token
    const token = jwt.sign(
      {
        userId: user.id,
        id: user.id,
        email: user.email,
        username: user.display_name,
        display_name: user.display_name,
      },
      process.env.JWT_SECRET!,
      { expiresIn: '7d' }
    );

    res.json({
      accessToken: token,
      idToken: token,
      refreshToken: token,
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

export default router;