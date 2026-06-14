import { forwardRef } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "ai";

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: "sm" | "md";
  fullWidth?: boolean;
};

const VARIANT_CLS: Record<Variant, string> = {
  primary: "neu-btn neu-btn-primary",
  secondary: "neu-btn",
  ghost: "text-[var(--neu-text-muted)] hover:text-[var(--neu-text)] rounded-xl",
  danger: "neu-btn text-c-rose",
  ai: "neu-btn",
};

const SIZE_CLS: Record<NonNullable<Props["size"]>, string> = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
};

export const Button = forwardRef<HTMLButtonElement, Props>(
  ({ variant = "secondary", size = "md", fullWidth, className = "", children, ...rest }, ref) => {
    return (
      <button
        ref={ref}
        {...rest}
        className={`
          inline-flex items-center justify-center gap-2
          font-medium select-none
          ${VARIANT_CLS[variant]}
          ${SIZE_CLS[size]}
          ${fullWidth ? "w-full" : ""}
          ${className}
        `}
      >
        {children}
      </button>
    );
  }
);
Button.displayName = "Button";
