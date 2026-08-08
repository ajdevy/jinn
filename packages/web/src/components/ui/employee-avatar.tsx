
import { useSettings } from "@/routes/settings-provider"
import { emojiForName } from "@/lib/emoji-pool"

interface EmployeeAvatarProps {
  name: string
  size?: number
  fontSize?: number
  className?: string
  style?: React.CSSProperties
  onClick?: () => void
}

export function EmployeeAvatar({
  name,
  size = 32,
  fontSize: fontSizeOverride,
  className,
  style,
  onClick,
}: EmployeeAvatarProps) {
  const { settings } = useSettings()
  const override = name ? settings.employeeOverrides[name] : undefined
  const emoji = override?.emoji || emojiForName(name || '')
  const fontSize = fontSizeOverride ?? Math.round(size * 0.6)

  return (
    <span
      className={className}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        fontSize,
        lineHeight: 1,
        borderRadius: "50%",
        flexShrink: 0,
        cursor: onClick ? "pointer" : undefined,
        userSelect: "none",
        ...style,
      }}
    >
      {emoji}
    </span>
  )
}
