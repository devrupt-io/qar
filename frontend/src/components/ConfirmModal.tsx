'use client';

import { ReactNode } from 'react';
import { AlertTriangle, Trash2, AlertCircle, Info, Loader2 } from 'lucide-react';
import Modal from './Modal';

type ModalVariant = 'danger' | 'warning' | 'info';

interface ConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  message: string | ReactNode;
  confirmText?: string;
  cancelText?: string;
  variant?: ModalVariant;
  isLoading?: boolean;
}

const variantConfig = {
  danger: {
    icon: Trash2,
    iconBg: 'bg-red-900/50',
    iconColor: 'text-red-400',
    buttonBg: 'bg-red-600 hover:bg-red-700',
  },
  warning: {
    icon: AlertTriangle,
    iconBg: 'bg-yellow-900/50',
    iconColor: 'text-yellow-400',
    buttonBg: 'bg-yellow-600 hover:bg-yellow-700',
  },
  info: {
    icon: Info,
    iconBg: 'bg-blue-900/50',
    iconColor: 'text-blue-400',
    buttonBg: 'bg-blue-600 hover:bg-blue-700',
  },
};

export default function ConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'danger',
  isLoading = false,
}: ConfirmModalProps) {
  const config = variantConfig[variant];
  const Icon = config.icon;

  const handleConfirm = async () => {
    await onConfirm();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} maxWidth="max-w-md">
      <div className="flex flex-col items-center text-center">
        {/* Icon */}
        <div className={`w-16 h-16 rounded-full ${config.iconBg} flex items-center justify-center mb-4`}>
          <Icon className={`w-8 h-8 ${config.iconColor}`} />
        </div>

        {/* Message */}
        <div className="text-slate-300 mb-6 whitespace-pre-wrap">
          {message}
        </div>

        {/* Buttons */}
        <div className="flex gap-3 w-full">
          <button
            onClick={onClose}
            disabled={isLoading}
            className="flex-1 btn-secondary"
          >
            {cancelText}
          </button>
          <button
            onClick={handleConfirm}
            disabled={isLoading}
            className={`flex-1 py-2 px-4 rounded-lg font-medium text-white transition-colors flex items-center justify-center gap-2 ${config.buttonBg} disabled:opacity-50`}
          >
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Processing...
              </>
            ) : (
              confirmText
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
}
