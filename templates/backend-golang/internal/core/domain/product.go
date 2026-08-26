package domain

// Product represents a product entity in the system.
type Product struct {
	BaseEntity
	Name     string `gorm:"column:name;type:varchar(255);not null" json:"name"`
	Price    int    `gorm:"column:price;not null" json:"price"`
	Quantity int    `gorm:"column:quantity;not null" json:"quantity"`
}

// TableName returns the database table name for Product.
func (Product) TableName() string {
	return "products"
}
