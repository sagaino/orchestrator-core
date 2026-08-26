package domain

import "time"

type BaseEntity struct {
	ID        string    `gorm:"primaryKey;type:char(36)" json:"id"`
	CreatedAt time.Time `gorm:"column:created_at;autoCreateTime:false" json:"createdAt"`
	UpdatedAt time.Time `gorm:"column:updated_at;autoUpdateTime:false" json:"updatedAt"`
	CreatedBy string    `gorm:"column:created_by;type:varchar(100)" json:"createdBy"`
	UpdatedBy string    `gorm:"column:updated_by;type:varchar(100)" json:"updatedBy"`
}

func (e *BaseEntity) SetCreated(actor string) {
	if actor != "" {
		e.CreatedBy = actor
		e.UpdatedBy = actor
	}
	e.CreatedAt = time.Now().UTC()
	e.UpdatedAt = time.Now().UTC()
}
