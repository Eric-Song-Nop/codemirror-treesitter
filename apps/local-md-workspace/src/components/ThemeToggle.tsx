import type { ComponentProps } from "react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { MoonIcon, SunIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { themeDefinition as getThemeDefinition, useTheme } from "@/theme";

type ThemeToggleProps = Omit<ComponentProps<typeof Button>, "aria-label" | "children" | "onClick">;

export function ThemeToggle({ size = "icon-sm", variant = "ghost", ...props }: ThemeToggleProps) {
  let { appearance, themeDefinition, toggleTheme } = useTheme();
  let pairedTheme = themeDefinition.pairedTheme
    ? getThemeDefinition(themeDefinition.pairedTheme)
    : null;
  let label = pairedTheme ? `Switch to ${pairedTheme.label}` : "Switch paired theme";
  let Icon = appearance == "dark" ? SunIcon : MoonIcon;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button aria-label={label} size={size} variant={variant} onClick={toggleTheme} {...props}>
          <Icon data-icon="inline-start" />
          <span className="sr-only">{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

type ThemeDropdownItemProps = {
  className?: string;
};

export function ThemeDropdownItem({ className }: ThemeDropdownItemProps) {
  let { appearance, themeDefinition, toggleTheme } = useTheme();
  let pairedTheme = themeDefinition.pairedTheme
    ? getThemeDefinition(themeDefinition.pairedTheme)
    : null;
  let label = pairedTheme ? `Switch to ${pairedTheme.label}` : "Switch paired theme";
  let Icon = appearance == "dark" ? SunIcon : MoonIcon;

  return (
    <DropdownMenuPrimitive.Item className={className} onSelect={() => toggleTheme()}>
      <Icon data-icon="inline-start" />
      {label}
    </DropdownMenuPrimitive.Item>
  );
}
