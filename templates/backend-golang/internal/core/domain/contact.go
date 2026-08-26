package domain

// Contact represents the contact domain entity in the system.
type Contact struct {
	BaseEntity
	Name        string `gorm:"column:name;type:varchar(255);not null;default:''" json:"name"`
	PhoneNumber string `gorm:"column:phone_number;type:varchar(50);not null;default:''" json:"phone_number"`
}

// TableName returns the database table name for Contact.
func (Contact) TableName() string {
	return "contacts"
}
